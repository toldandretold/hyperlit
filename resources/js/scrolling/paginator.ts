/**
 * paginator — the paginated ("fixed pages") reading-mode engine.
 *
 * The trick (same as Epub.js/Readium): in paginated mode the reader wrapper
 * becomes a clipped, non-scrolling viewport and `.main-content` gets a CSS
 * multi-column layout whose column width = the wrapper's content width and
 * whose column height = the visible band. The BROWSER fragments the text into
 * viewport-sized columns; a "page" is just a horizontal translate of one
 * column stride. Font-size / viewport changes reflow the columns — we only
 * re-measure and re-anchor.
 *
 * Pagination operates on the lazyLoader's loaded chunk WINDOW, not the whole
 * book: paging near the window's right edge appends the next chunk (appends
 * add columns to the right and cannot shift earlier pages), paging near the
 * left edge prepends the previous chunk and instantly re-anchors (prepends
 * shift every page).
 *
 * Import posture: near-leaf. Only zero-import leaves (currentLazyLoaderState,
 * navState), the logger, and the preference switcher. scrollHelpers imports
 * THIS module as its paginated delegate — importing scrollHelpers from here
 * would close a cycle, so exit-scroll does its own offsetTop math.
 *
 * Reading-position gate: this module never touches the saved-position storage key.
 * It calls the active loader's saveScrollPosition() after every page turn (no
 * scroll events fire in paginated mode, so the throttled scroll-save never
 * triggers on its own); the ONE detector in lazyLoader forceSavePosition has a
 * horizontal branch for paginated mode.
 */

import { verbose } from '../utilities/logger';
import { currentLazyLoader } from '../pageLoad/currentLazyLoaderState';
import { userScrollState } from './navState';
import { getFreshAnchor } from './readingAnchor';
import { getReadingMode, READING_MODES } from '../components/settingsContainer/readingModeSwitcher';

/** The slice of the lazyLoader instance the paginator drives. */
interface LoaderLike {
  bookId: string;
  container: HTMLElement;
  scrollableParent: HTMLElement | Window;
  pagingMode?: boolean;
  currentlyLoadedChunks: Set<number>;
  nodes?: Array<{ startLine?: string | number }>;
  saveScrollPosition?: () => void;
  loadNextChunk?: (currentLastChunkId: number, instance: LoaderLike) => Promise<void>;
  loadPreviousChunk?: (currentFirstChunkId: number, instance: LoaderLike) => Promise<void>;
}

const NUMERIC_ID = /^\d+(\.\d+)?$/;
/** Turn animation duration must match the CSS transition on .main-content. */
const EXIT_HEADER_OFFSET = 192; // matches scroll-padding-top / internalNav headerOffset

// ── Module state ───────────────────────────────────────────────────────────
let engaged = false;
let suspendedForEdit = false;
/**
 * FROZEN: engaged, but not reacting to layout events. Set while an overlay that
 * mutates the reader viewport is open — the hyperlit (highlight/annotation)
 * container. Writing into it opens the mobile keyboard (a window resize) and
 * inserts a highlight <mark> into main (a childList mutation); left un-frozen,
 * BOTH fire remeasure()/snap and shove the pages sideways under the user, and
 * leave page/stride/scrollLeft desynced so the NEXT page turn lands wrong.
 * Freeze suppresses all reactive re-anchoring; unfreeze does ONE clean
 * remeasure to re-sync geometry to the (possibly changed) DOM + viewport.
 */
let frozen = false;
/** The exact page we were on when frozen — restored verbatim on unfreeze. */
let frozenPage = 0;
let wrapper: HTMLElement | null = null;
let main: HTMLElement | null = null;
let loader: LoaderLike | null = null;
let page = 0;
let pageCount = 1;
let stride = 0;
let padL = 0;
/**
 * The anchor node id of the CURRENT page, updated after every deliberate
 * page move. Re-measures (font change, viewport change, chunk mutations) must
 * re-anchor to THIS — recomputing "first element on the page" after a reflow
 * reads the new layout at the old scroll offset, which is different content.
 */
let currentAnchorId: string | null = null;
/**
 * A STICKY navigation target (deep link / hypercite / search result). Unlike
 * currentAnchorId — which every page turn and settle-snap overwrites with
 * "first element on the current page" — this survives reflows until the user
 * DELIBERATELY turns a page. It exists because a deep-link lands, then a
 * previous chunk prepends (internalNav loads target±1) and shifts every page
 * right; without a sticky reference the re-anchor followed the page's first
 * paragraph and the target drifted off-screen (the "#hypercite_ lands two
 * pages short" bug). remeasure() re-finds THIS first.
 */
let navTargetId: string | null = null;
/**
 * Pages the sticky nav anchor sits PAST its own first fragment. A node longer
 * than a page has one id but spans several pages; resuming a saved reading
 * position must land on the page the reader was actually on, not the node's
 * first page. forceSavePosition records this offset; restore replays it here.
 */
let navPageOffset = 0;
let mutationObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let remeasureRaf = 0;
let chunkLoadInFlight = false;
let boundWindowResize: (() => void) | null = null;
let boundWrapperScroll: (() => void) | null = null;
let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
/** Debounce for snapping settled scrolls to a page boundary. */
let scrollSnapTimer: ReturnType<typeof setTimeout> | null = null;

export function isPaginatorEngaged(): boolean {
  return engaged;
}

export function getPageInfo(): { page: number; pageCount: number } | null {
  return engaged ? { page, pageCount } : null;
}

function emitState(): void {
  window.dispatchEvent(new CustomEvent('paginatorstate', {
    detail: { engaged, page, pageCount, percent: percentThroughBook() },
  }));
}

/**
 * Percent-through-book from the anchor node's position in the loader's node
 * list. Page numbers would be window-relative and font-size-dependent; this is
 * stable and honest. (For chunked books mid background-download it's percent
 * of the downloaded portion — close enough, and self-corrects as data lands.)
 */
function percentThroughBook(): number | null {
  if (!engaged || !loader) return null;
  const nodes = loader.nodes;
  if (!nodes?.length) return null;
  const anchor = firstElementOnCurrentPage();
  if (!anchor) return null;
  const idx = nodes.findIndex((n) => String(n.startLine) === anchor.id);
  if (idx < 0) return null;
  return Math.min(100, Math.round(((idx + 1) / nodes.length) * 100));
}

// ── Geometry ───────────────────────────────────────────────────────────────

/**
 * Measure the wrapper/main geometry and set the CSS vars the column layout
 * consumes. Column width = wrapper content width minus main's horizontal
 * padding; column gap = that padding sum — which makes the page stride
 * exactly the wrapper's clientWidth, so every page's text sits at the same
 * padding offsets. Page height = wrapper clientHeight: main is border-box,
 * so its own top/bottom padding keeps the text inside the wrapper's
 * clip-path band.
 */
function computeVars(): void {
  if (!wrapper || !main) return;
  const cs = getComputedStyle(main);
  padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const gap = padL + padR;
  const colWidth = Math.max(50, wrapper.clientWidth - gap);
  wrapper.style.setProperty('--pg-col-width', `${colWidth}px`);
  wrapper.style.setProperty('--pg-col-gap', `${gap}px`);
  wrapper.style.setProperty('--pg-page-height', `${wrapper.clientHeight}px`);
  stride = colWidth + gap;
}

/**
 * Pure page math (exported for the vitest unit test): which page a left-edge
 * offset falls on. Both rects shift together with the wrapper's scroll, so the current
 * translate cancels out of (elLeft - mainLeft). The +0.05 epsilon absorbs
 * sub-pixel column rounding without letting a real indent (a fraction of a
 * stride) bump the result to the next page.
 */
export function pageFromOffsets(elLeft: number, mainLeft: number, padLeft: number, strideWidth: number): number {
  if (strideWidth <= 0) return 0;
  return Math.max(0, Math.floor((elLeft - mainLeft - padLeft) / strideWidth + 0.05));
}

/**
 * Which page an element STARTS on. Uses the FIRST client rect (the fragment
 * where the element begins), not getBoundingClientRect — the union box lies
 * two ways in a column layout: a paragraph longer than a page unions across
 * every page it spans, and an inline hypercite that starts near a line's
 * right edge sits so close to the column boundary that edge math (plus the
 * sub-pixel epsilon) tipped navigation one page over. The first fragment's
 * CENTER is always strictly inside the start column.
 */
function pageOfElement(el: Element): number {
  if (!main || stride <= 0) return 0;
  const first = el.getClientRects()[0];
  const r = first ?? el.getBoundingClientRect();
  return pageFromOffsets(r.left + r.width / 2, main.getBoundingClientRect().left, padL, stride);
}

/**
 * Total pages = the page holding the LAST content element + 1. Measured with
 * the same rect math as pageOfElement instead of trusting scrollWidth, whose
 * semantics for multicol overflow columns vary across engines.
 */
function computePageCount(): void {
  if (!main) { pageCount = 1; return; }
  const last = main.querySelector(':scope > .sentinel:last-of-type')
    || lastNodeElement();
  pageCount = last ? pageOfElement(last) + 1 : 1;
}

function nodeElements(): HTMLElement[] {
  if (!main) return [];
  return Array.from(main.querySelectorAll<HTMLElement>('.chunk > [id]'))
    .filter((el) => NUMERIC_ID.test(el.id));
}

function lastNodeElement(): HTMLElement | null {
  const els = nodeElements();
  return els[els.length - 1] ?? null;
}

/** First node element visible on the current page (the paginated anchor). */
function firstElementOnCurrentPage(): HTMLElement | null {
  if (!wrapper) return null;
  const wrapRect = wrapper.getBoundingClientRect();
  for (const el of nodeElements()) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right > wrapRect.left + 1 && rect.left < wrapRect.right - 1) {
      return el;
    }
  }
  return null;
}

// ── Page application ───────────────────────────────────────────────────────

/**
 * Pages are shown by SCROLLING the wrapper (overflow:hidden boxes are still
 * programmatically scrollable), NOT by a CSS transform on main. This is a
 * hard requirement, discovered the painful way: Chromium's CDP
 * DOM.getContentQuads returns broken (untransformed) coordinates for content
 * inside transform-translated multicol overflow columns, so every CDP-driven
 * click (Playwright/automation/some AT) computed an off-viewport click point
 * and retried forever — while getBoundingClientRect said the element was
 * perfectly visible. Scroll offsets don't have that bug, native
 * scrollIntoView works out of the box (snapped to a page boundary by the
 * scroll listener), and smooth page turns come free from scrollTo.
 *
 * (A transform-paging experiment was tried to see if it would restore native
 * iOS selection painting in pages mode — it did NOT: the selection break is a
 * WebKit multicol limitation, independent of scroll-vs-transform, so we reverted
 * to scrolling and draw the selection band ourselves in paginatedSelectionBand.ts,
 * the same overlay-from-getClientRects technique foliate-js / epub.js use.)
 */
function applyPage(instant: boolean): void {
  if (!wrapper) return;
  wrapper.scrollTo({ left: page * stride, top: 0, behavior: instant ? ('instant' as ScrollBehavior) : 'smooth' });
}

function setPage(n: number, instant = false): void {
  // A deliberate page move supersedes any pending native-scroll snap.
  if (scrollSnapTimer) { clearTimeout(scrollSnapTimer); scrollSnapTimer = null; }
  page = Math.min(Math.max(0, n), Math.max(0, pageCount - 1));
  applyPage(instant);
}

/**
 * The pages-mode replacement for a native `el.scrollIntoView(...)` on reader
 * content. Returns true when HANDLED (paginator engaged AND `el` is inside
 * the paginated main — flipped to its page); returns false otherwise so the
 * caller runs its original scroll code untouched. Usage at every legacy site:
 *
 *   if (!maybePaginatorReveal(el)) el.scrollIntoView({ ...original args });
 *
 * This keeps scroll-mode behavior byte-identical. Never let a native
 * scrollIntoView run against the paginated wrapper — it scrolls the
 * overflow:hidden box (top AND left) and corrupts the page geometry.
 */
export function maybePaginatorReveal(el: Element | null): boolean {
  if (!engaged || !el || !main?.contains(el)) return false;
  return goToElement(el as HTMLElement);
}

/**
 * Show the page containing `el`. Returns false when the element isn't in the
 * loaded window (caller decides whether to load its chunk first).
 */
/**
 * Pin a sticky navigation target by ID STRING, for deep links whose exact
 * target may not be in the DOM yet — a hypercite/highlight marker that renders
 * a beat AFTER the nav resolves its chunk. remeasure() re-resolves this id on
 * every reflow, so the page snaps to the marker the instant it appears (and
 * stays there through the prepend that shifts every page). Scrolling the
 * containing NODE instead lands on the paragraph's FIRST page — pages away
 * from a marker sitting mid-paragraph in a node longer than a page.
 */
export function setPaginatorNavTarget(id: string | null, pageOffset = 0): void {
  navTargetId = id;
  // Clamp: a saved value from SCROLL mode is a pixel offset (large); reading it
  // as a page count would fling us off the book. A real page-in-node is tiny.
  navPageOffset = (pageOffset >= 0 && pageOffset <= 8) ? pageOffset : 0;
  if (!engaged || !id || !main) return;
  const el = main.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
  if (el && el.isConnected) {
    setPage(pageOfElement(el) + navPageOffset, true);
    afterTurn(id);
  }
  // Not in the DOM yet → navTargetId/navPageOffset stay pinned; the
  // MutationObserver's remeasure re-resolves them once the element renders.
}

export function goToElement(el: HTMLElement | null, opts: { instant?: boolean } = {}): boolean {
  if (!engaged || !el || !el.isConnected || !main?.contains(el)) return false;
  // A navigation may land here right after a chunk insert, before the
  // MutationObserver's rAF remeasure — refresh the count so the clamp in
  // setPage doesn't cap the turn at a stale window edge.
  computePageCount();
  // THE NAV TARGET IS THE STICKY ANCHOR. On a deep link the target's page is
  // not final: preference reflow (font/width) AND a prepended previous chunk
  // both shift it AFTER we land. Pin the id so every subsequent remeasure
  // re-finds the exact element the user navigated to, until they turn a page.
  navTargetId = el.id || null;
  setPage(pageOfElement(el), opts.instant === true);
  afterTurn(el.id || undefined);
  return true;
}

function afterTurn(anchorId?: string): void {
  currentAnchorId = anchorId ?? firstElementOnCurrentPage()?.id ?? currentAnchorId;
  loader?.saveScrollPosition?.();
  emitState();
}

/** The tracked anchor element, if still in the loaded window. */
function currentAnchorElement(): HTMLElement | null {
  if (!main || !currentAnchorId) return null;
  return main.querySelector<HTMLElement>(`[id="${CSS.escape(currentAnchorId)}"]`);
}

// ── Re-measure (font change, viewport change, chunk mutations) ────────────

/**
 * Recompute geometry after any layout-affecting change, keeping `anchorEl`
 * (default: the current page's first element) on screen — instantly, no
 * animation.
 */
export function remeasure(anchorEl?: HTMLElement | null): void {
  if (!engaged || !wrapper || !main || frozen) return;
  // Anchor priority: explicit caller anchor → the STICKY nav target (a deep
  // link / search result being settled — survives the prepend+reflow that
  // would otherwise leave it two pages back) → the tracked page anchor. The
  // live "first on page" scan is deliberately NOT the default — it reads the
  // reflowed layout at the stale scroll offset and re-anchors to wrong content.
  const navEl = navTargetId ? main.querySelector<HTMLElement>(`[id="${CSS.escape(navTargetId)}"]`) : null;
  const usingNav = !anchorEl && navEl && navEl.isConnected;
  const anchor = (anchorEl && anchorEl.isConnected) ? anchorEl
    : usingNav ? navEl
    : currentAnchorElement();
  computeVars();
  computePageCount();
  if (anchor && anchor.isConnected) {
    // Apply the sticky page-offset ONLY when re-anchoring to the nav target
    // (a multi-page node resumed to its Nth page), not to an ordinary anchor.
    setPage(pageOfElement(anchor) + (usingNav ? navPageOffset : 0), true);
    currentAnchorId = anchor.id || currentAnchorId;
  } else {
    setPage(page, true); // clamp into the new range
  }
  emitState();
}

function scheduleRemeasure(): void {
  if (!engaged || remeasureRaf || frozen) return;
  remeasureRaf = requestAnimationFrame(() => {
    remeasureRaf = 0;
    remeasure();
  });
}

// ── Chunk-window integration ───────────────────────────────────────────────

function edgeChunkId(which: 'first' | 'last'): number | null {
  if (!main) return null;
  const chunks = main.querySelectorAll(':scope > [data-chunk-id]');
  const el = which === 'first' ? chunks[0] : chunks[chunks.length - 1];
  if (!el) return null;
  const parsed = parseFloat(el.getAttribute('data-chunk-id') || '');
  return Number.isFinite(parsed) ? parsed : null;
}

/** Append the next chunk (columns grow rightwards — earlier pages don't move). */
async function loadNextChunkPaginated(): Promise<boolean> {
  if (!loader?.loadNextChunk || chunkLoadInFlight) return false;
  const lastId = edgeChunkId('last');
  if (lastId === null) return false;
  chunkLoadInFlight = true;
  try {
    const before = loader.currentlyLoadedChunks.size;
    await loader.loadNextChunk(lastId, loader);
    const grew = loader.currentlyLoadedChunks.size > before;
    if (grew) computePageCount();
    return grew;
  } finally {
    chunkLoadInFlight = false;
  }
}

/**
 * Prepend the previous chunk. Prepends shift EVERY page right, so capture the
 * current page's anchor first and re-anchor instantly after the reflow.
 */
async function loadPreviousChunkPaginated(): Promise<boolean> {
  if (!loader?.loadPreviousChunk || chunkLoadInFlight) return false;
  const firstId = edgeChunkId('first');
  if (firstId === null) return false;
  chunkLoadInFlight = true;
  try {
    const anchor = firstElementOnCurrentPage();
    const before = loader.currentlyLoadedChunks.size;
    await loader.loadPreviousChunk(firstId, loader);
    const grew = loader.currentlyLoadedChunks.size > before;
    if (grew) remeasure(anchor);
    return grew;
  } finally {
    chunkLoadInFlight = false;
  }
}

// ── Page turns ─────────────────────────────────────────────────────────────

export async function nextPage(): Promise<void> {
  if (!engaged) return;
  navTargetId = null;
  navPageOffset = 0; // a deliberate turn releases the sticky deep-link anchor
  computePageCount(); // chunk mutations may not have hit the rAF remeasure yet
  if (page >= pageCount - 1) {
    // At the window's right edge: try to grow it, then turn.
    const grew = await loadNextChunkPaginated();
    if (!grew || page >= pageCount - 1) { emitState(); return; }
  }
  setPage(page + 1);
  afterTurn();
  // Prefetch: keep ~2 pages of runway so the next turn is instant.
  if (page >= pageCount - 3) void loadNextChunkPaginated().then(() => emitState());
}

export async function prevPage(): Promise<void> {
  if (!engaged) return;
  navTargetId = null;
  navPageOffset = 0; // a deliberate turn releases the sticky deep-link anchor
  if (page === 0) {
    const grew = await loadPreviousChunkPaginated();
    // remeasure() re-anchored us to the same content; page is now > 0 if a
    // chunk landed in front of us.
    if (!grew || page === 0) { emitState(); return; }
  }
  setPage(page - 1);
  afterTurn();
  if (page <= 1) void loadPreviousChunkPaginated().then(() => emitState());
}

// ── Engagement lifecycle ───────────────────────────────────────────────────

function resolveReaderLoader(): LoaderLike | null {
  const candidate = currentLazyLoader as LoaderLike | null;
  if (!candidate?.container) return null;
  const parent = candidate.scrollableParent;
  if (!(parent instanceof HTMLElement) || !parent.classList.contains('reader-content-wrapper')) {
    return null; // sub-book / home / user loaders never paginate
  }
  return candidate;
}

export function enterPaginatedMode(opts: { deferToRestore?: boolean } = {}): void {
  if (engaged) return;
  const candidate = resolveReaderLoader();
  if (!candidate) return;

  // Capture the CURRENT reading anchor while the layout is STILL vertical (scroll
  // mode). getFreshAnchor re-runs the position detector synchronously — but it
  // MUST run BEFORE we flip to columns (pagingMode/paginated-active reset
  // scrollLeft to 0), else the detector reads the first node of page 0 instead of
  // where the reader actually is, and the Scroll→Pages toggle jumps to the top.
  // Skipped on the boot path — restoreScrollPosition owns positioning there.
  const enterAnchorId = opts.deferToRestore
    ? null
    : getFreshAnchor(candidate.bookId)?.elementId ?? null;

  loader = candidate;
  wrapper = candidate.scrollableParent as HTMLElement;
  main = candidate.container;

  loader.pagingMode = true;
  engaged = true;
  wrapper.classList.add('paginated-active');
  computeVars();
  computePageCount();

  if (opts.deferToRestore) {
    // BOOT / reader-entry engagement: restoreScrollPosition() is the ONE
    // boot-positioning authority (hash → ?scroll= → saved position → top),
    // exactly like scroll mode — its final positioning funnels through the
    // scrollHelpers seam into goToElement. The paginator must NOT position
    // itself from the saved anchor here: on a cold deep link the saved
    // anchor is the (server-seeded) OLD bookmark, and landing there emits
    // scroll events whose throttled save re-stamps that bookmark as fresh —
    // which flips restore's resume-vs-jump arbitration against the URL hash
    // (the "pasted a #hypercite_ link into a new browser and it never
    // appeared" bug). Sit quietly on page 0; restore will place us.
    setPage(0, true);
    currentAnchorId = null;
    navTargetId = null;
    navPageOffset = 0;
  } else {
    // Mid-session engagement (settings toggle, exiting edit mode): no restore is
    // coming — open the page holding the reader's CURRENT position, captured
    // fresh above while the layout was still vertical.
    const savedEl = enterAnchorId
      ? main.querySelector<HTMLElement>(`[id="${CSS.escape(enterAnchorId)}"]`)
      : null;
    if (savedEl) {
      setPage(pageOfElement(savedEl), true);
      currentAnchorId = savedEl.id;
    } else {
      setPage(0, true);
      currentAnchorId = null;
      navTargetId = null;
      navPageOffset = 0;
    }
  }

  // Chunk-level DOM mutations (nav loads, self-heal, background download)
  // reflow every column — one debounced remeasure covers all producers.
  mutationObserver = new MutationObserver(() => scheduleRemeasure());
  mutationObserver.observe(main, { childList: true });

  resizeObserver = new ResizeObserver(() => scheduleRemeasure());
  resizeObserver.observe(wrapper);

  // textControls dispatches a debounced window resize after font/width steps.
  boundWindowResize = () => {
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => remeasure(), 60);
  };
  window.addEventListener('resize', boundWindowResize);

  // Snap scrolls to page boundaries once they settle. Scroll events here come
  // from our own scrollTo page turns (smooth animation fires many) AND from
  // NATIVE scroll attempts — the browser's own scrollIntoView (CDP/Playwright
  // click positioning), find-in-page, fragment navigation, accessibility
  // tools. After ~450ms of quiet, whatever offset we ended up at becomes the
  // nearest page. Own turns settle exactly on a boundary (no-op); native
  // attempts get tidied onto one without yanking the element the browser
  // just positioned (a mid-flight reset made automation stability checks
  // ping-pong forever).
  boundWrapperScroll = () => {
    if (!engaged || !wrapper || frozen) return;
    if (scrollSnapTimer) clearTimeout(scrollSnapTimer);
    scrollSnapTimer = setTimeout(() => {
      scrollSnapTimer = null;
      if (!engaged || !wrapper || stride <= 0 || frozen) return;
      const sl = wrapper.scrollLeft;
      const target = Math.min(Math.max(0, Math.round(sl / stride)), Math.max(0, pageCount - 1));
      if (sl === target * stride && wrapper.scrollTop === 0 && target === page) return; // settled on a boundary
      page = target;
      wrapper.scrollTo({ left: target * stride, top: 0, behavior: 'instant' as ScrollBehavior });
      afterTurn();
    }, 450);
  };
  wrapper.addEventListener('scroll', boundWrapperScroll, { passive: true });

  // No position save on enter: storage already holds the anchor we just read,
  // and in the mid-restore case a save here would stomp the bookmark.
  emitState();
  verbose.nav(`Paginated mode engaged (${pageCount} pages in window)`, '/scrolling/paginator.ts');
}

export function exitPaginatedMode(): HTMLElement | null {
  if (!engaged) return null;
  const anchor = firstElementOnCurrentPage();

  teardownObservers();
  engaged = false;
  if (loader) loader.pagingMode = false;

  if (wrapper && main) {
    // Clear the paging scroll offset BEFORE the layout flips back to vertical
    // (the snap listener was just removed in teardownObservers).
    wrapper.scrollLeft = 0;
    wrapper.classList.remove('paginated-active');
    wrapper.style.removeProperty('--pg-col-width');
    wrapper.style.removeProperty('--pg-col-gap');
    wrapper.style.removeProperty('--pg-page-height');

    if (anchor && anchor.isConnected) {
      // Direct offsetTop math (scrollHelpers imports this module — no cycle).
      // The wrapper is position:relative, so offsetTop chains resolve to it.
      userScrollState.isNavigating = true;
      wrapper.scrollTop = Math.max(0, offsetTopWithinWrapper(anchor, wrapper) - EXIT_HEADER_OFFSET);
      setTimeout(() => { userScrollState.isNavigating = false; }, 100);
    }
  }

  loader?.saveScrollPosition?.();
  emitState();
  verbose.nav('Paginated mode disengaged', '/scrolling/paginator.ts');

  const anchorOut = anchor;
  wrapper = null;
  main = null;
  loader = null;
  page = 0;
  pageCount = 1;
  currentAnchorId = null;
  navTargetId = null;
  navPageOffset = 0;
  frozen = false;
  return anchorOut;
}

function offsetTopWithinWrapper(el: HTMLElement, wrapperEl: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== wrapperEl) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
    if (node === wrapperEl) break;
  }
  return top;
}

function teardownObservers(): void {
  mutationObserver?.disconnect();
  mutationObserver = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (boundWindowResize) {
    window.removeEventListener('resize', boundWindowResize);
    boundWindowResize = null;
  }
  if (boundWrapperScroll) {
    // Before any exit-path scrollTop restore — the snap listener must not
    // fight the deliberate return to scroll mode.
    wrapper?.removeEventListener('scroll', boundWrapperScroll);
    boundWrapperScroll = null;
  }
  if (scrollSnapTimer) { clearTimeout(scrollSnapTimer); scrollSnapTimer = null; }
  if (resizeDebounce) { clearTimeout(resizeDebounce); resizeDebounce = null; }
  if (remeasureRaf) { cancelAnimationFrame(remeasureRaf); remeasureRaf = 0; }
}

/**
 * Drop all engine state WITHOUT touching the DOM — for SPA teardown where the
 * reader DOM is being replaced anyway (scroll restore against a detached
 * wrapper would be meaningless).
 */
export function disengageSilently(): void {
  if (!engaged) return;
  teardownObservers();
  if (loader) loader.pagingMode = false;
  engaged = false;
  wrapper = null;
  main = null;
  loader = null;
  page = 0;
  pageCount = 1;
  currentAnchorId = null;
  navTargetId = null;
  navPageOffset = 0;
  frozen = false;
  emitState();
}

// ── Edit-mode round-trip ───────────────────────────────────────────────────

/** Edit button pressed while paginated: drop to scroll flow at the anchor. */
export function suspendForEdit(): void {
  if (!engaged) return;
  suspendedForEdit = true;
  exitPaginatedMode();
}

/** Edit mode left: re-engage iff the preference still says paginated. */
export function resumeAfterEdit(): void {
  suspendedForEdit = false;
  syncEngagement();
}

// ── Overlay round-trip (hyperlit container) ─────────────────────────────────

/**
 * An overlay that mutates the reader viewport (the hyperlit container) is
 * opening. Unlike suspendForEdit this does NOT drop to scroll flow — the pages
 * stay exactly where they are; we just stop reacting to the keyboard resize and
 * the highlight-mark insertion that would otherwise slide them around. No-op
 * outside paginated mode, so callers can fire it unconditionally.
 */
export function freezePaginator(): void {
  if (!engaged) return;
  frozen = true;
  frozenPage = page; // remember the EXACT page — unfreeze restores this verbatim
  // A page-turn snap may already be queued from a scroll just before the freeze.
  if (scrollSnapTimer) { clearTimeout(scrollSnapTimer); scrollSnapTimer = null; }
}

/**
 * The overlay closed. Re-sync geometry to the DOM (a highlight mark may have
 * been added) and viewport (the keyboard closed → window height restored),
 * re-anchoring to the current page so the next turn computes from correct
 * stride/pageCount/scrollLeft. The ResizeObserver/window-resize that fire as
 * the keyboard finishes closing will, now un-frozen, re-run this if needed —
 * so an early call here is self-correcting, not a one-shot race.
 */
export function unfreezePaginator(): void {
  if (!frozen) return;
  frozen = false;
  if (!engaged || !wrapper || !main) return;
  // Re-measure geometry (a highlight mark may have been inserted; the keyboard
  // resize may have changed the band) but restore the EXACT page we froze on —
  // NOT pageOfElement(anchor), which for a paragraph spanning several pages
  // returns the node's FIRST page and snaps the reader back a page on close.
  computeVars();
  computePageCount();
  setPage(frozenPage, true);
  currentAnchorId = firstElementOnCurrentPage()?.id ?? currentAnchorId;
  emitState();
}

// ── Reconciler ─────────────────────────────────────────────────────────────

/**
 * One idempotent reconciler: preference × page type × edit state → engaged or
 * not. Callers: pageNav init (after the first chunk lands — passes
 * deferToRestore so boot positioning stays with restoreScrollPosition), the
 * readingmodechange listener, resumeAfterEdit.
 */
export function syncEngagement(opts: { deferToRestore?: boolean } = {}): void {
  const want = getReadingMode() === READING_MODES.PAGINATED
    && !suspendedForEdit
    && document.body.getAttribute('data-page') === 'reader'
    && (window as unknown as { isEditing?: boolean }).isEditing !== true;
  if (want) {
    enterPaginatedMode(opts);
  } else {
    exitPaginatedMode();
  }
}
