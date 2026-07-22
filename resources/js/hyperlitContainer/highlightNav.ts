/**
 * highlightNav — prev/next arrows over the user's own highlights, living
 * inside the open hyperlit container. Navigation swaps the container's content
 * IN PLACE (containerSwap) and scrolls the main book — never close/reopen.
 *
 * Only ever imported DYNAMICALLY (from postOpen.ts), which keeps the
 * postOpen → highlightNav → containerSwap → postOpen ring out of the static
 * import graph.
 *
 * Ghost highlights (underlying text deleted — see hyperlights/myHighlights/ghost)
 * participate in document order via their last-known startLine; navigating to
 * one scrolls near the old location and floats the shared 👻 bubble instead of
 * glowing a mark.
 *
 * (A "see all highlights" surface was prototyped here and removed — the
 * intended future shape is a quantizer-style multi-container view, see
 * resources/js/quantizer/.)
 */

import { log, verbose } from '../utilities/logger';
import { openDatabase } from '../indexedDB/core/connection';
import type { HyperciteRecord, HyperlightRecord } from '../indexedDB/types';
import { getAuthContextSync, getAuthContext } from '../utilities/auth/index';
import {
  getOwnedAnnotationsForBook,
  getAdjacentAnnotation,
  getAnnotationPosition,
  annotationId,
  type AuthIdentity,
  type OwnedAnnotation,
} from '../hyperlights/myHighlights/list';
import { isHighlightGhosted, isHyperciteGhosted } from '../hyperlights/myHighlights/ghost';
import { currentLazyLoader } from '../pageLoad/currentLazyLoaderState';
import { navigateToInternalId } from '../scrolling/internalNav';
import { spawnGhostBubble } from '../hypercites/animations';
import { registerListener } from './containerState';
import { getDepth, getCurrentContainer } from './stack';
import { detectHighlights, detectHypercites } from './detection';
import { swapTopLayerContent } from './containerSwap';

let navInFlight = false;

/** Breadcrumb for tests/diagnosis (the __fnDiag pattern) — prod console is
 *  silenced (IS_PROD), so guard exits record WHY here instead. */
function navDiag(reason: string): void {
  try { (window as any).__hlNavDiag = reason; } catch { /* no-op */ }
}

/** The book segment the address bar should use (slug-aware — mirrors index.ts). */
function resolveRenderedBookSegment(): string {
  const readerMainEl = document.querySelector('.main-content') as HTMLElement | null;
  const mainId = readerMainEl?.id || '';
  const mainSlug = readerMainEl?.getAttribute?.('data-slug') || '';
  const urlFirst = window.location.pathname.split('/').filter(Boolean)[0] || '';
  if (mainSlug && urlFirst === mainSlug) return mainSlug;
  return mainId || urlFirst;
}

function renderedMainBookId(): string {
  return (document.querySelector('.main-content') as HTMLElement | null)?.id || '';
}

async function resolveAuth(): Promise<AuthIdentity> {
  const auth = getAuthContextSync() || await getAuthContext();
  return { user: auth?.user ?? null, userId: auth?.userId ?? null };
}

async function fetchRecord(highlightId: string, db: IDBDatabase): Promise<HyperlightRecord | null> {
  return new Promise((resolve) => {
    try {
      const idx = db.transaction('hyperlights', 'readonly').objectStore('hyperlights').index('hyperlight_id');
      const req = idx.get(highlightId);
      req.onsuccess = () => resolve((req.result as HyperlightRecord) || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function fetchCiteRecord(hyperciteId: string, db: IDBDatabase): Promise<HyperciteRecord | null> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction('hypercites', 'readonly')
        .objectStore('hypercites')
        .get([renderedMainBookId(), hyperciteId]);
      req.onsuccess = () => resolve((req.result as HyperciteRecord) || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Render the ↑↓ arrows into the container. Called from postOpen's deferred
 * block on every (re)build — idempotent. The arrows traverse the user's
 * MIXED "hyperlighted" list (highlights + <u> cites, document order).
 * Renders NOTHING unless: the view is one of the user's own annotations in
 * the rendered main book, on the base layer, outside brain mode.
 */
export async function attachHighlightNavUI(container: HTMLElement, navContentType: any, options: any = {}): Promise<void> {
  container.querySelector('.hyperlit-nav-arrows')?.remove();

  if (!navContentType || options?.brainModeHighlightId) {
    navDiag('skip:no-ct-or-brain');
    return;
  }
  if (getDepth() > 1) {
    navDiag(`skip:stacked-depth-${getDepth()}`);
    return; // stacked layers sit over other containers, not the reader
  }
  // The current annotation's id: a highlight view carries highlightIds, a
  // hypercite view carries hyperciteId.
  const currentId: string | undefined = navContentType.highlightIds?.[0] || navContentType.hyperciteId;
  if (!currentId) {
    navDiag('skip:no-annotation-id');
    return;
  }
  const mainBookId = renderedMainBookId();
  if (!mainBookId) {
    navDiag('skip:no-main-book');
    return;
  }

  // Ownership + book scoping in ONE test: the ordered list contains exactly the
  // user's annotations for the rendered main book. (Deliberately NOT the
  // ct.highlightOwnership cache — buildUnifiedContent spreads content types into
  // copies before buildContent, so caches set there never reach postOpen's ct.)
  const auth = await resolveAuth();
  const db = await openDatabase();
  const ordered = await getOwnedAnnotationsForBook(mainBookId, auth, db);
  if (!ordered.some((e) => annotationId(e) === currentId)) {
    navDiag(`skip:not-owned-in-book:${currentId}`);
    return;
  }
  navDiag('guards-passed');

  const pos = getAnnotationPosition(ordered, currentId);

  const wrap = document.createElement('div');
  wrap.className = 'hyperlit-nav-arrows';
  wrap.innerHTML = `
    <button type="button" class="hyperlit-nav-btn hyperlit-nav-prev" title="Previous" aria-label="Previous hyperlighted">↑</button>
    <button type="button" class="hyperlit-nav-btn hyperlit-nav-next" title="Next" aria-label="Next hyperlighted">↓</button>
  `;
  container.appendChild(wrap);

  const prevBtn = wrap.querySelector('.hyperlit-nav-prev') as HTMLButtonElement;
  const nextBtn = wrap.querySelector('.hyperlit-nav-next') as HTMLButtonElement;

  const prev = getAdjacentAnnotation(ordered, currentId, -1);
  const next = getAdjacentAnnotation(ordered, currentId, 1);
  prevBtn.disabled = !prev;
  nextBtn.disabled = !next;
  if (pos) {
    prevBtn.title = `Previous (${pos.index + 1} / ${pos.total})`;
    nextBtn.title = `Next (${pos.index + 1} / ${pos.total})`;
  }

  if (prev) {
    registerListener(prevBtn, 'click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      void openAnnotationInPlace(annotationId(prev.entry));
    });
  }
  if (next) {
    registerListener(nextBtn, 'click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      void openAnnotationInPlace(annotationId(next.entry));
    });
  }
  navDiag('attached');
}

/**
 * Swap the container to the given annotation (replaceState — an arrow step is
 * not its own history entry) and scroll the main book to it. Ids are
 * self-describing: HL_* = highlight, hypercite_* = <u> cite.
 */
export async function openAnnotationInPlace(id: string): Promise<void> {
  if (id.startsWith('hypercite_')) return openHyperciteInPlace(id);
  return openHighlightInPlace(id);
}

/** Hypercite arm of openAnnotationInPlace. */
async function openHyperciteInPlace(hyperciteId: string): Promise<void> {
  if (navInFlight) return;
  navInFlight = true;
  try {
    const db = await openDatabase();
    const record = await fetchCiteRecord(hyperciteId, db);
    const ghosted = record ? isHyperciteGhosted(record) : false;

    const ct = await detectHypercites(null, hyperciteId, db);
    if (!ct) return;

    const swapped = await swapTopLayerContent([ct], [], {
      pushHistoryEntry: false,
      urlOverride: `/${resolveRenderedBookSegment()}#${hyperciteId}`,
      anchorId: hyperciteId,
    });
    if (!swapped) return;

    // Scroll AFTER the swap (fire-and-forget). Live cites scroll to the <u>;
    // ghost cites scroll to their invisible tombstone anchor (regenerated per
    // render from the record) and float the 👻 bubble there. internalNav's
    // auto-open only fires for HL_/Fn ids, so no suppress flag is needed.
    void (async () => {
      if (!currentLazyLoader) return;
      try {
        await navigateToInternalId(hyperciteId, currentLazyLoader, false);
      } catch { /* fall through to the anchor fallback below */ }
      if (ghosted) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const { revealGhostIfTombstone } = await import('../hypercites/animations');
        if (!revealGhostIfTombstone(hyperciteId) && record) {
          // Tombstone not rendered (e.g. its node was deleted) — anchor fallback.
          const { resolveAnchorStartLine } = await import('../hyperlights/myHighlights/list');
          const anchor = await resolveAnchorStartLine(record, db);
          const anchorEl = anchor ? document.getElementById(anchor) : null;
          if (anchorEl) spawnGhostBubble(anchorEl.getBoundingClientRect(), hyperciteId);
        }
      }
    })();
  } catch (error) {
    log.error('openHyperciteInPlace failed', 'hyperlitContainer/highlightNav.ts', error as any);
  } finally {
    navInFlight = false;
  }
}

/**
 * Highlight arm of openAnnotationInPlace.
 */
export async function openHighlightInPlace(highlightId: string): Promise<void> {
  if (navInFlight) return;
  navInFlight = true;
  try {
    const db = await openDatabase();
    const record = await fetchRecord(highlightId, db);
    if (!record) {
      verbose.nav(`openHighlightInPlace: no record for ${highlightId}`, 'hyperlitContainer/highlightNav');
      return;
    }
    const ghosted = await isHighlightGhosted(record, db);

    const ct = await detectHighlights(null, [highlightId], db);
    if (!ct) return;

    const swapped = await swapTopLayerContent([ct], [], {
      pushHistoryEntry: false,
      urlOverride: `/${resolveRenderedBookSegment()}#${highlightId}`,
      anchorId: highlightId,
    });
    if (!swapped) return;

    if (ghosted) markContainerGhosted(highlightId);

    // Main-content scroll AFTER the swap (fire-and-forget: a slow chunk fetch
    // must never block the container's own update).
    if (ghosted) {
      void navigateToGhostAnchor(record);
    } else {
      void scrollMainToHighlight(highlightId, record);
    }
  } catch (error) {
    log.error('openHighlightInPlace failed', 'hyperlitContainer/highlightNav.ts', error as any);
  } finally {
    navInFlight = false;
  }
}

/**
 * Flag the container's rendered section for a ghosted highlight: 👻 next to
 * the author line + dimmed blockquote. DOM-decoration only — never persisted
 * (the blockquote is user-editable; the flag lives OUTSIDE it).
 */
function markContainerGhosted(highlightId: string): void {
  const container = getCurrentContainer();
  if (!container) return;
  const author = container.querySelector(`#author-${CSS.escape(highlightId)} > div`);
  if (author && !author.querySelector('.ghost-flag')) {
    const flag = document.createElement('i');
    flag.className = 'ghost-flag';
    flag.title = 'The highlighted text was removed from the book';
    flag.textContent = ' 👻';
    author.firstElementChild?.appendChild(flag);
  }
  container
    .querySelector(`blockquote.highlight-text[data-highlight-id="${CSS.escape(highlightId)}"]`)
    ?.classList.add('ghosted');
}

/**
 * The "from afar" flow — open an annotation from a surface OUTSIDE the
 * container (TOC hyperlights tab; reusable by the ghost ledger): open the
 * hyperlit container (works whether or not the mark/<u> is rendered — postOpen
 * attaches the ↑↓ arrows), then scroll the reader appropriately: ghosts get
 * the anchor/tombstone scroll + 👻 bubble (never the 6s mark-hunt), live ones
 * the normal scroll + glow. Ids self-describe: HL_* or hypercite_*.
 */
export async function navigateAndOpenAnnotation(id: string): Promise<void> {
  if (!id.startsWith('hypercite_')) return navigateAndOpenHighlight(id);
  try {
    const db = await openDatabase();
    const record = await fetchCiteRecord(id, db);
    const ghosted = record ? isHyperciteGhosted(record) : false;

    // Direct-ID open (containerActions delegator) — same path deep links use.
    const { handleUnifiedContentClick } = await import('./containerActions');
    await handleUnifiedContentClick(null, null, [], false, false, id);

    if (!currentLazyLoader) return;
    try {
      await navigateToInternalId(id, currentLazyLoader, false);
    } catch { /* anchor fallback below */ }
    if (ghosted) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const { revealGhostIfTombstone } = await import('../hypercites/animations');
      if (!revealGhostIfTombstone(id) && record) {
        const { resolveAnchorStartLine } = await import('../hyperlights/myHighlights/list');
        const anchor = await resolveAnchorStartLine(record, db);
        const anchorEl = anchor ? document.getElementById(anchor) : null;
        if (anchorEl) spawnGhostBubble(anchorEl.getBoundingClientRect(), id);
      }
    }
  } catch (error) {
    log.error('navigateAndOpenAnnotation failed', 'hyperlitContainer/highlightNav.ts', error as any);
  }
}

export async function navigateAndOpenHighlight(highlightId: string): Promise<void> {
  try {
    const db = await openDatabase();
    const record = await fetchRecord(highlightId, db);
    if (!record) {
      verbose.nav(`navigateAndOpenHighlight: no record for ${highlightId}`, 'hyperlitContainer/highlightNav');
      return;
    }
    const ghosted = await isHighlightGhosted(record, db);

    const { openHighlightById } = await import('../hyperlights/utils');
    await openHighlightById(highlightId);

    if (ghosted) {
      markContainerGhosted(highlightId);
      void navigateToGhostAnchor(record);
    } else {
      void scrollMainToHighlight(highlightId, record);
    }
  } catch (error) {
    log.error('navigateAndOpenHighlight failed', 'hyperlitContainer/highlightNav.ts', error as any);
  }
}

/**
 * Scroll the reader to a live highlight's mark and glow its group. If the mark
 * turns out NOT to render (detection said "live" but the renderer disagrees —
 * positions drifted in a way the content test couldn't see), fall back to the
 * ghost flow so the user still lands near the old location with the 👻 bubble
 * instead of a silent no-op.
 */
async function scrollMainToHighlight(highlightId: string, record: HyperlightRecord): Promise<void> {
  if (!currentLazyLoader) return;
  let navFailed = false;
  try {
    // suppressContainerOpen: the container is already open and swapped — without
    // this, internalNav's 200ms auto-open would stack a second container.
    await navigateToInternalId(highlightId, currentLazyLoader, false, null, { suppressContainerOpen: true });
  } catch {
    navFailed = true;
  }
  if (navFailed || !document.querySelector(`mark.${CSS.escape(highlightId)}`)) {
    verbose.nav(`scrollMainToHighlight: no mark for ${highlightId} — ghost fallback`, 'hyperlitContainer/highlightNav');
    markContainerGhosted(highlightId);
    void navigateToGhostAnchor(record);
    return;
  }
  try {
    const { getMarkGroup } = await import('../hyperlights/markGroup');
    document.querySelectorAll('.cascade-origin').forEach((el) => el.classList.remove('cascade-origin'));
    const anchorMark = document.querySelector(`mark.${CSS.escape(highlightId)}`);
    if (anchorMark) {
      const group = getMarkGroup(anchorMark);
      (group.length > 0 ? group : [anchorMark]).forEach((m) => (m as HTMLElement).classList.add('cascade-origin'));
    }
    void import('../scrolling/index').then(({ setCascadeOriginId }: any) => setCascadeOriginId(highlightId));
  } catch { /* glow is cosmetic — never fail the nav over it */ }
}

/**
 * Ghost flow: scroll near the highlight's last-known location and float the 👻
 * bubble there. The anchor is RESOLVED from the record's nodes' current
 * startLines (renumber-stable — a mid-node ghost's paragraph may have been
 * renumbered since); the stored startLine is only the fallback for ghosts
 * whose node was deleted entirely.
 */
async function navigateToGhostAnchor(record: HyperlightRecord): Promise<void> {
  if (!currentLazyLoader) return;
  const { resolveAnchorStartLine } = await import('../hyperlights/myHighlights/list');
  const db = await openDatabase();
  let targetId = await resolveAnchorStartLine(record, db);
  const startLineNum = parseFloat(String(targetId ?? ''));

  // Fallback: nearest preceding node in the loaded node list.
  if (targetId && Number.isFinite(startLineNum) && Array.isArray(currentLazyLoader.nodes)) {
    const exists = currentLazyLoader.nodes.some((n: any) => String(n.startLine) === targetId);
    if (!exists) {
      let best: any = null;
      for (const n of currentLazyLoader.nodes) {
        const sl = Number(n.startLine);
        if (Number.isFinite(sl) && sl <= startLineNum && (!best || sl > Number(best.startLine))) best = n;
      }
      targetId = best ? String(best.startLine) : null;
    }
  }
  if (!targetId) {
    verbose.nav(`navigateToGhostAnchor: no anchor for ${record.hyperlight_id}`, 'hyperlitContainer/highlightNav');
    return;
  }

  try {
    await navigateToInternalId(targetId, currentLazyLoader, false, null, { suppressContainerOpen: true });
  } catch { /* keep going — the bubble can still spawn if the node is rendered */ }

  // Let the scroll/page-snap settle before measuring the anchor's rect.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const anchorEl = document.getElementById(targetId);
  if (anchorEl) {
    spawnGhostBubble(anchorEl.getBoundingClientRect(), record.hyperlight_id);
  }
}
