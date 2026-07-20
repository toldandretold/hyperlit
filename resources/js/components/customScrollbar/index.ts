/**
 * customScrollbar — an accurate scrollbar for the chunk-windowed reader
 * (ButtonRegistry component, reader page, read + scroll mode only).
 *
 * The DOM holds at most MAX_LOADED_CHUNKS chunks, so native scrollbar geometry
 * is meaningless. This bar maps the WHOLE book through the virtual coordinate
 * space built by virtualMap.ts:
 *
 *  - Thumb sync: a passive scroll listener (rAF-coalesced) finds which loaded
 *    chunk straddles the wrapper's top edge, takes the fraction through it, and
 *    maps that onto the chunk's virtual span. Real and virtual accumulators both
 *    reset at every chunk boundary, so height-estimation error never drifts.
 *  - Scrub: while dragging, ONLY the thumb + minimap move (the preview is the
 *    live feedback; no DOM work mid-drag — that janked the drag). The content
 *    jump fires on release / track-tap and routes through the loader's own
 *    chunk machinery (loadChunk's atomic reservation + sorted insertion) under
 *    lockScroll — mirroring internalNav's fast/clear paths.
 *    Jumps are single-flight with latest-wins queueing, so rapid scrubbing can
 *    never overlap two window rebuilds.
 *
 * Deliberately NOT here: any read of the saved reading-position storage key
 *    (the accessor gate — position saving stays with forceSavePosition, which
 *    unlockScroll triggers for us), and any second "which node is visible"
 *    detector (the straddling-chunk scan feeds only this widget's thumb,
 *    never saved state).
 */

import { log, verbose } from '../../utilities/logger';
import { currentLazyLoader } from '../../pageLoad/currentLazyLoaderState';
import { pendingFirstChunkLoadedPromise } from '../../pageLoad/firstChunkPromise';
import { isPaginatorEngaged } from '../../scrolling/paginator';
import { scrollElementWithConsistentMethod } from '../../scrolling/scrollHelpers';
import { parseChunkId } from '../../indexedDB/types';
import type { NodeRecord } from '../../indexedDB/types';
import { MAX_LOADED_CHUNKS, trimWindow } from '../../lazyLoader/utilities/windowChunks';
import {
  buildVirtualMap,
  indexAtVirtual,
  isMapStale,
  type VirtualMap,
  type VirtualMapMetrics,
} from './virtualMap';
import { createMinimap, type MinimapController } from './minimap';
import {
  makeWidthKey,
  heightLookup,
  harvestLiveChunk,
  startIdleSweep,
  stopIdleSweep,
  measuredCount,
} from './measure';

/** The slice of the lazyLoader instance this component consumes. */
interface LoaderLike {
  bookId: string;
  nodes: NodeRecord[];
  container: HTMLElement;
  scrollableParent: HTMLElement | Window;
  currentlyLoadedChunks: Set<number>;
  loadChunk: (chunkId: number, direction?: string) => Promise<unknown>;
  repositionSentinels: () => void;
  lockScroll: (reason?: string) => void;
  unlockScroll: () => void;
}

const SRC = 'components/customScrollbar';
/** Keep in sync with reader.blade.php's clip-path: inset(15px 0 40px 0) on the wrapper. */
const CLIP_TOP = 15;
const CLIP_BOTTOM = 40;
const MIN_THUMB_PX = 24;
/**
 * Scrub landings put the target node at the TOP of the viewport (just under the
 * 15px clip), like a real scrollbar — NOT at the app-wide 192px nav offset.
 * The minimap's viewport band starts at the target node, so a 192px landing
 * offset would push the band's bottom fifth off-screen ("I saw the title in
 * the preview but not on the page").
 */
const SCRUB_LAND_OFFSET = 16;
const REBUILD_DEBOUNCE_MS = 1000;

// ── module state (document-delegated singleton, the pageNav pattern) ────────
let root: HTMLElement | null = null;
let thumb: HTMLElement | null = null;
let minimap: MinimapController | null = null;

let loader: LoaderLike | null = null;
let boundWrapper: HTMLElement | null = null;
let map: VirtualMap | null = null;

/**
 * Two binding modes:
 *  - 'chunk': backed by a lazy loader (reader, or a home/user arranger
 *    collection). The DOM is a ~7-chunk window, so position comes from the
 *    virtual map + measured heights and scrubbing routes through the chunk-jump
 *    machinery.
 *  - 'plain': the home/user FEED/hero wrapper (`.welcome-copy` etc.) — ordinary
 *    scrollable DOM with NO lazy loader. The whole content is present, so the
 *    thumb maps straight to scrollTop and scrubbing just sets scrollTop. No map,
 *    no measurement, no minimap.
 */
let mode: 'chunk' | 'plain' | null = null;
/** The bound identity for rebind-detection: the loader (chunk) or wrapper (plain). */
let boundTarget: unknown = null;

let scrollHandler: (() => void) | null = null;
let windowListeners: Array<[string, EventListener]> = [];
let chunkObserver: MutationObserver | null = null;
/** Watches .perimeter-hidden on the chrome cluster — the bar is chrome and fades with it. */
let perimeterObserver: MutationObserver | null = null;
let chunkElsCache: HTMLElement[] | null = null;

// Real-height measurement wiring (measure.ts).
let currentWidthKey = '';
let containerWidth = 0;
/** Chunk elements fully harvested (all nodes measured, images loaded). */
let harvestedChunks = new WeakSet<HTMLElement>();
/** Per-chunk-element earliest next harvest retry (ms timestamp) while images load. */
let harvestRetryAt = new WeakMap<HTMLElement, number>();

let syncRaf = 0;
let geometryRaf = 0;
let paintRaf = 0;
let paintSpanCenter = 0;
let paintBandTop = 0;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let resizeDebounce: ReturnType<typeof setTimeout> | null = null;

// Track geometry (viewport px), recomputed on bind/resize/mode change.
let barTop = 0;
let trackH = 0;

// Last synced content position (virtual px) — seeds the scrub start.
let lastVPos = 0;
let lastViewportVirtual = 0;
/**
 * Running calibration: estimated-px per real-px, sampled from whichever chunk
 * straddles the viewport top during normal reading (EMA). The minimap band
 * height converts the screen's real clientHeight into virtual units — without
 * this, any systematic bias in the height estimator stretches/shrinks the band
 * and it stops meaning "what you'll see".
 */
let estPerRealEma = 1;
let thumbTop = 0;
let thumbH = MIN_THUMB_PX;

// Scrub state.
let scrubbing = false;
let hovering = false;
let canvasHover = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let dragStartY = 0;
let dragStartThumbTop = 0;
let pendingIdx: number | null = null;
/** Raw virtual position of the pending scrub target (mid-node precision). */
let pendingV: number | null = null;

// Jump single-flight.
let jumpInFlight = false;
let queuedJump: { idx: number; v: number } | null = null;
let lastCommittedIdx: number | null = null;
let lastCommittedV: number | null = null;

/** A generation counter: a rebind invalidates every in-flight async continuation. */
let bindGeneration = 0;

function isEditing(): boolean {
  return (window as unknown as { isEditing?: boolean }).isEditing === true;
}

function idle(fn: () => void): void {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (ric) ric(fn);
  else setTimeout(fn, 50);
}


// ── DOM ─────────────────────────────────────────────────────────────────────

function ensureDom(): void {
  if (root) return;
  root = document.createElement('div');
  root.className = 'custom-scrollbar';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true'); // presentation aid; keyboard nav has its own paths

  const track = document.createElement('div');
  track.className = 'custom-scrollbar-track';
  thumb = document.createElement('div');
  thumb.className = 'custom-scrollbar-thumb';

  root.appendChild(track);
  root.appendChild(thumb);
  document.body.appendChild(root);

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  root.addEventListener('pointerenter', onPointerEnter);
  root.addEventListener('pointerleave', onPointerLeave);

  minimap = createMinimap({ onJump: handleMinimapJump, onHoverChange: handleMinimapHover });
}

function cancelHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/** Grace-period hide: crossing the gap from the bar onto the popup (or a touch
 *  lift) must not kill the popup before the pointer arrives / the tap lands. */
function hideSoon(): void {
  cancelHide();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (!hovering && !canvasHover && !scrubbing) minimap?.hide();
  }, 300);
}

function handleMinimapHover(h: boolean): void {
  canvasHover = h;
  if (h) cancelHide();
  else hideSoon();
  updateFade();
}

/** Click inside the preview → jump to exactly what was clicked. */
function handleMinimapJump(v: number): void {
  if (!map) return;
  const idx = indexAtVirtual(map, v);
  verbose.nav(`minimap click → virtual ${Math.round(v)} (idx ${idx})`, SRC);
  hovering = false;
  canvasHover = false;
  cancelHide();
  minimap?.hide();
  void commitJump(idx, v);
}

function removeDom(): void {
  minimap?.destroy();
  minimap = null;
  root?.remove();
  root = null;
  thumb = null;
}

// ── geometry & visibility ───────────────────────────────────────────────────

/** Breathing room between the bar's ends and the corner button clusters. */
const BUTTON_GAP = 8;

function updateGeometry(): void {
  if (!root || !boundWrapper) return;
  const rect = boundWrapper.getBoundingClientRect();
  let top = rect.top + CLIP_TOP;
  let bottom = rect.bottom - CLIP_BOTTOM;
  // Keep the bar clear of the right-edge button clusters: below the cloudRef
  // sync button (top right), above the edit/contents cluster (bottom right).
  // Perimeter chrome can be hidden (rect collapses) — then the clip insets win.
  const cloud = document.getElementById('cloudRef')?.getBoundingClientRect();
  if (cloud && cloud.height > 0) top = Math.max(top, cloud.bottom + BUTTON_GAP);
  const cluster = document.getElementById('bottom-right-buttons')?.getBoundingClientRect();
  if (cluster && cluster.height > 0) bottom = Math.min(bottom, cluster.top - BUTTON_GAP);
  const height = Math.max(0, bottom - top);
  // Self-diffing: called on every sync tick (the button clusters settle after
  // their .loading phase and can move later, e.g. when chrome appears) — only
  // write styles when the extent actually changed.
  if (Math.abs(top - barTop) < 1 && Math.abs(height - trackH) < 1) return;
  barTop = top;
  trackH = height;
  root.style.top = `${barTop}px`;
  root.style.height = `${trackH}px`;
}

/** Is the perimeter chrome currently tapped away? (toggle component, search
 *  toolbar, and edit button all write this class; the observer in bindLoader
 *  catches every writer). */
function chromeHidden(): boolean {
  return (
    document.getElementById('bottom-right-buttons')?.classList.contains('perimeter-hidden') ??
    false
  );
}

/** How long after the last scroll the bar stays up while the chrome is hidden. */
const SCROLL_FADE_MS = 2000;
let scrollActive = false;
let scrollFadeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Fade model (the cloudRef-glow precedent — independent of chrome when it has
 * to be): chrome VISIBLE → bar always visible (improved browser default);
 * chrome HIDDEN → native behavior: visible while scrolling + a grace period,
 * faded otherwise. Interacting with the bar (hover/scrub/popup) keeps it up.
 */
function updateFade(): void {
  if (!root) return;
  const visible = !chromeHidden() || scrollActive || scrubbing || hovering || canvasHover;
  root.classList.toggle('custom-scrollbar--faded', !visible);
  if (!visible) minimap?.hide();
}

function noteScrollActivity(): void {
  scrollActive = true;
  updateFade();
  if (scrollFadeTimer) clearTimeout(scrollFadeTimer);
  scrollFadeTimer = setTimeout(() => {
    scrollFadeTimer = null;
    scrollActive = false;
    updateFade();
  }, SCROLL_FADE_MS);
}

function updateVisibility(): void {
  if (!root) return;
  const page = document.body.getAttribute('data-page');
  const onScrollbarPage = page === 'reader' || page === 'home' || page === 'user';
  // Content must overflow the viewport, else there's nothing to scroll — hide
  // the bar like a native scrollbar would.
  let show = false;
  if (onScrollbarPage && !!boundWrapper && !isPaginatorEngaged() && !isEditing()) {
    if (mode === 'plain') {
      show = boundWrapper.isConnected && boundWrapper.scrollHeight > boundWrapper.clientHeight + 4;
    } else if (mode === 'chunk') {
      show =
        !!loader &&
        loader.container.isConnected && // collection swapped away (home→feed) → stale, hide
        !!map &&
        map.totalHeight > boundWrapper.clientHeight + 4;
    }
  }
  root.hidden = !show;
  if (!show) minimap?.hide();
  updateFade();
}

// ── loader binding ──────────────────────────────────────────────────────────

/** The bar's scroll wrappers: the reader, plus the home/user feed wrappers once
 *  an arranger collection loads chunk-windowed content into them. Sub-book /
 *  hyperlit-container scrollers are excluded (not one of these three). */
const BAR_WRAPPERS = ['reader-content-wrapper', 'home-content-wrapper', 'user-content-wrapper'];

function resolveReaderLoader(): LoaderLike | null {
  const candidate = currentLazyLoader as LoaderLike | null;
  // isConnected: when a home/user feed closes back to the hero, the collection's
  // .main-content is removed but currentLazyLoader may still point at it — treat
  // that as no loader so plain mode can take over.
  if (!candidate?.container || !candidate.container.isConnected) return null;
  const parent = candidate.scrollableParent;
  if (!(parent instanceof HTMLElement) || !BAR_WRAPPERS.some((c) => parent.classList.contains(c))) {
    return null;
  }
  return candidate;
}

/**
 * The home/user FEED/hero wrapper when it's plain scrollable DOM with NO lazy
 * loader (the `.welcome-copy` marketing scroll, or any non-chunked feed). Reader
 * always has a loader, so plain mode never applies there.
 */
function resolvePlainWrapper(): HTMLElement | null {
  const page = document.body.getAttribute('data-page');
  if (page !== 'home' && page !== 'user') return null;
  const sel = page === 'home' ? '.home-content-wrapper' : '.user-content-wrapper';
  const w = document.querySelector<HTMLElement>(sel);
  if (!w || !w.isConnected) return null;
  if (w.scrollHeight <= w.clientHeight + 4) return null; // nothing to scroll yet
  return w;
}

function unbindLoader(): void {
  if (boundWrapper && scrollHandler) {
    boundWrapper.removeEventListener('scroll', scrollHandler);
  }
  // Hand the native scrollbar back to the feed wrapper we were replacing.
  boundWrapper?.classList.remove('custom-scrollbar-owned');
  scrollHandler = null;
  chunkObserver?.disconnect();
  chunkObserver = null;
  perimeterObserver?.disconnect();
  perimeterObserver = null;
  chunkElsCache = null;
  loader = null;
  boundWrapper = null;
  map = null;
  mode = null;
  boundTarget = null;
  lastCommittedIdx = null;
  lastCommittedV = null;
  queuedJump = null;
  stopIdleSweep();
  currentWidthKey = '';
  harvestedChunks = new WeakSet();
  harvestRetryAt = new WeakMap();
  if (scrollFadeTimer) clearTimeout(scrollFadeTimer);
  scrollFadeTimer = null;
  scrollActive = false;
}

/** The element the bar SHOULD be bound to right now (loader wins over plain wrapper). */
function currentTarget(): LoaderLike | HTMLElement | null {
  return resolveReaderLoader() ?? resolvePlainWrapper();
}

/**
 * (Re)bind ONLY when the active target actually changed. Home/user content swaps
 * (arranger collection load, or feed↔hero) happen WITHOUT a ButtonRegistry
 * re-init, so nothing calls bindLoader — but the arranger dispatches a `resize`
 * afterward (and `contentUpdated` fires on server-changed refreshes). Both route
 * here; cheap on ordinary window resizes (same target → no-op).
 */
function maybeRebind(): void {
  if (currentTarget() !== boundTarget) bindLoader();
}

/** Chrome-fade observer + the wrapper scroll listener — shared by both modes. */
function wireWrapperListeners(): void {
  if (!boundWrapper) return;
  boundWrapper.classList.add('custom-scrollbar-owned'); // re-hide the native bar we replace
  scrollHandler = () => {
    noteScrollActivity();
    if (!syncRaf) syncRaf = requestAnimationFrame(syncThumb);
  };
  boundWrapper.addEventListener('scroll', scrollHandler, { passive: true });
  const cluster = document.getElementById('bottom-right-buttons');
  if (cluster) {
    perimeterObserver = new MutationObserver(() => updateVisibility());
    perimeterObserver.observe(cluster, { attributes: true, attributeFilter: ['class'] });
  }
  updateGeometry();
}

function bindLoader(): void {
  bindGeneration++;
  unbindLoader();

  const candidate = resolveReaderLoader();
  if (candidate) {
    mode = 'chunk';
    boundTarget = candidate;
    loader = candidate;
    boundWrapper = candidate.scrollableParent as HTMLElement;
    wireWrapperListeners();
    // Loaded-chunk element list changes only on childList mutations (chunk in/out).
    chunkObserver = new MutationObserver(() => {
      chunkElsCache = null;
      if (!syncRaf) syncRaf = requestAnimationFrame(syncThumb);
    });
    chunkObserver.observe(candidate.container, { childList: true });
    scheduleRebuild(0);
    verbose.init(`customScrollbar bound (chunk) to book ${candidate.bookId}`, SRC);
    return;
  }

  const plain = resolvePlainWrapper();
  if (plain) {
    // Plain-DOM mode: the whole content is present, so scrubbing scrolls the real
    // DOM directly — no map, no measurement, no minimap, no chunk machinery.
    mode = 'plain';
    boundTarget = plain;
    boundWrapper = plain;
    wireWrapperListeners();
    if (!syncRaf) syncRaf = requestAnimationFrame(syncThumb);
    updateVisibility();
    verbose.init('customScrollbar bound (plain DOM) to a feed wrapper', SRC);
    return;
  }

  updateVisibility();
}

// ── virtual map lifecycle ───────────────────────────────────────────────────

function measureLayout(instance: LoaderLike): {
  metrics: VirtualMapMetrics;
  widthKey: string;
  width: number;
} {
  const cs = getComputedStyle(instance.container);
  const fontSize = parseFloat(cs.fontSize) || 18;
  const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.6;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const textWidth = Math.max(80, instance.container.clientWidth - padL - padR);
  // ~0.5em average glyph width for body text — the estimator's fallback for
  // nodes the measurement pass hasn't reached yet.
  const charsPerLine = Math.max(10, textWidth / (fontSize * 0.5));
  const width = instance.container.getBoundingClientRect().width;
  return {
    metrics: { lineHeight, charsPerLine, blockMargin: fontSize },
    widthKey: makeWidthKey(width, fontSize),
    width,
  };
}

/** (Re)start the offscreen sweep — self-cancelling, skips measured chunks. */
function restartSweep(): void {
  if (!loader || !map || !currentWidthKey || map.chunkIdsSorted.length === 0) return;
  const generation = bindGeneration;
  const anchorIdx = indexAtVirtual(map, lastVPos);
  const anchorChunk = anchorIdx >= 0 ? map.chunkOf[anchorIdx] ?? 0 : 0;
  void startIdleSweep({
    nodes: loader.nodes,
    chunkIdsSorted: map.chunkIdsSorted,
    currentChunkId: anchorChunk,
    bookId: loader.bookId,
    containerWidth,
    widthKey: currentWidthKey,
    onProgress: () => {
      if (generation === bindGeneration) scheduleRebuild(1000);
    },
  }).catch(() => {});
}

function scheduleRebuild(delayMs: number = REBUILD_DEBOUNCE_MS): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  const generation = bindGeneration;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    idle(() => {
      if (generation !== bindGeneration || !loader) return;
      const layout = measureLayout(loader);
      if (layout.widthKey !== currentWidthKey) {
        // Width/font changed — cached measurements for the old layout no
        // longer apply (they simply miss on lookup) and the sweep restarts
        // below with the new key.
        stopIdleSweep();
        currentWidthKey = layout.widthKey;
        containerWidth = layout.width;
      }
      map = buildVirtualMap(loader.nodes, layout.metrics, heightLookup(currentWidthKey));
      updateVisibility();
      if (!syncRaf) syncRaf = requestAnimationFrame(syncThumb);
      verbose.content(
        `customScrollbar map built: ${map.nodeIds.length} nodes, ${Math.round(map.totalHeight)}vpx, ${measuredCount()} measured`,
        SRC,
      );
      restartSweep();
    });
  }, delayMs);
}

// ── thumb sync (content → thumb) ────────────────────────────────────────────

function getChunkEls(): HTMLElement[] {
  if (!chunkElsCache && loader) {
    chunkElsCache = Array.from(
      loader.container.querySelectorAll<HTMLElement>('[data-chunk-id]'),
    );
  }
  return chunkElsCache ?? [];
}

/**
 * Live harvest: measure real node heights from chunks the reader has already
 * rendered (free + exact, includes loaded images). Each chunk element is
 * measured once; chunks with still-loading images retry at most 1×/second.
 */
function harvestVisibleChunks(chunkEls: HTMLElement[]): void {
  if (!loader || !currentWidthKey) return;
  const now = performance.now();
  let added = 0;
  for (const el of chunkEls) {
    if (harvestedChunks.has(el)) continue;
    if (now < (harvestRetryAt.get(el) ?? 0)) continue;
    harvestRetryAt.set(el, now + 1000);
    const attr = el.getAttribute('data-chunk-id');
    if (attr === null) continue;
    const chunkId = Number(parseChunkId(attr));
    const nodes = loader.nodes.filter((n) => Number(n.chunk_id) === chunkId);
    if (nodes.length === 0) continue;
    const res = harvestLiveChunk(el, nodes, currentWidthKey);
    added += res.added;
    if (res.skipped === 0) harvestedChunks.add(el);
  }
  if (added > 0) scheduleRebuild(1000);
}

/** Plain-DOM thumb sync: scrollTop maps straight to the track (no virtual map). */
function syncThumbPlain(): void {
  if (!thumb || !boundWrapper) return;
  const sh = boundWrapper.scrollHeight;
  const ch = boundWrapper.clientHeight;
  const range = sh - ch;
  thumbH = Math.min(trackH, Math.max(MIN_THUMB_PX, sh > 0 ? (trackH * ch) / sh : trackH));
  const frac = range > 0 ? Math.min(1, Math.max(0, boundWrapper.scrollTop / range)) : 0;
  thumbTop = frac * (trackH - thumbH);
  thumb.style.height = `${thumbH}px`;
  thumb.style.transform = `translateY(${thumbTop}px)`;
}

function syncThumb(): void {
  syncRaf = 0;
  if (!root || !thumb || !boundWrapper) return;
  updateVisibility();
  if (root.hidden || scrubbing) return;
  updateGeometry(); // cheap when unchanged; tracks the settling button clusters

  if (mode === 'plain') {
    syncThumbPlain();
    return;
  }
  if (!loader || !map) return;

  if (isMapStale(map, loader.nodes)) scheduleRebuild();

  const wrapTop = boundWrapper.getBoundingClientRect().top;
  const chunkEls = getChunkEls();
  if (chunkEls.length === 0) return;
  harvestVisibleChunks(chunkEls);

  // First loaded chunk whose bottom edge is below the wrapper top = the chunk
  // straddling (or next below) the top edge. ≤ MAX_LOADED_CHUNKS rect reads.
  let target: HTMLElement | null = null;
  let rect: DOMRect | null = null;
  for (const el of chunkEls) {
    const r = el.getBoundingClientRect();
    if (r.bottom > wrapTop) {
      target = el;
      rect = r;
      break;
    }
  }
  if (!target || !rect) {
    const last = chunkEls[chunkEls.length - 1];
    if (!last) return;
    target = last;
    rect = last.getBoundingClientRect();
  }

  const chunkId = Number(parseChunkId(target.getAttribute('data-chunk-id') ?? '0'));
  const bound = map.chunkBounds.get(chunkId);
  if (!bound || rect.height <= 0) return; // stale map vs live DOM — next rebuild fixes it

  const f = Math.min(1, Math.max(0, (wrapTop - rect.top) / rect.height));
  const chunkVSpan = bound.vEnd - bound.vStart;
  lastVPos = bound.vStart + f * chunkVSpan;
  // The page moved under us — the last scrub target no longer describes where
  // we are, so it must not dedupe the next commit (the "drag back to where I
  // once jumped does nothing" bug).
  lastCommittedIdx = null;
  lastCommittedV = null;
  // Local real→virtual scale converts the viewport height into virtual px.
  const localRatio = chunkVSpan / rect.height;
  lastViewportVirtual = boundWrapper.clientHeight * localRatio;
  if (Number.isFinite(localRatio) && localRatio > 0) {
    estPerRealEma = estPerRealEma * 0.8 + localRatio * 0.2;
  }

  positionThumb(lastVPos, lastViewportVirtual);
}

function positionThumb(vPos: number, viewportVirtual: number): void {
  if (!thumb || !map || trackH <= 0) return;
  const total = map.totalHeight;
  if (total <= 0) return;
  thumbH = Math.min(trackH, Math.max(MIN_THUMB_PX, trackH * (viewportVirtual / total)));
  const scrollableVirtual = Math.max(0, total - viewportVirtual);
  const frac = scrollableVirtual > 0 ? Math.min(1, Math.max(0, vPos / scrollableVirtual)) : 0;
  thumbTop = frac * (trackH - thumbH);
  thumb.style.height = `${thumbH}px`;
  thumb.style.transform = `translateY(${thumbTop}px)`;
}

// ── scrub (thumb → content) ─────────────────────────────────────────────────

function viewportVirtualEstimate(): number {
  // The virtual space is denominated in ESTIMATED real pixels, so the wrapper's
  // clientHeight × the measured est-per-real ratio (EMA over rendered chunks)
  // is the screen's span at an arbitrary (unrendered) target.
  if (boundWrapper) return boundWrapper.clientHeight * estPerRealEma;
  if (lastViewportVirtual > 0) return lastViewportVirtual;
  return map ? map.totalHeight / 50 : 0;
}

function vPosOfThumbTop(top: number): number {
  if (!map) return 0;
  const scrollableVirtual = Math.max(0, map.totalHeight - viewportVirtualEstimate());
  const range = trackH - thumbH;
  return range > 0 ? (Math.min(range, Math.max(0, top)) / range) * scrollableVirtual : 0;
}

/** Plain-DOM scrub: set scrollTop directly, live — the whole content is present,
 *  so there's no chunk machinery to route through. */
function scrubToPlain(top: number): void {
  if (!thumb || !boundWrapper) return;
  const clamped = Math.min(Math.max(0, top), Math.max(0, trackH - thumbH));
  thumbTop = clamped;
  thumb.style.transform = `translateY(${clamped}px)`;
  const range = boundWrapper.scrollHeight - boundWrapper.clientHeight;
  const thumbRange = trackH - thumbH;
  const frac = thumbRange > 0 ? clamped / thumbRange : 0;
  boundWrapper.scrollTop = frac * range;
}

function scrubTo(top: number): void {
  if (mode === 'plain') {
    scrubToPlain(top);
    return;
  }
  if (!map || !thumb) return;
  const clamped = Math.min(Math.max(0, top), Math.max(0, trackH - thumbH));
  thumbTop = clamped;
  thumb.style.transform = `translateY(${clamped}px)`; // immediate — must track the finger
  const vPos = vPosOfThumbTop(clamped);
  pendingIdx = indexAtVirtual(map, vPos);
  pendingV = vPos;
  // Everything glides on the RAW position — no node snapping anywhere. The
  // landing is mid-node-accurate (commitJump's intra-node offset), so the band
  // no longer needs a snapped top edge; snapping it made the band hop in
  // node-sized steps against the smoothly gliding lens. The jump itself fires
  // on release only: committing mid-drag rebuilt the chunk window under the
  // finger.
  schedulePaint(vPos, vPos);
}

/** One canvas repaint per frame, however fast pointermove fires. */
function schedulePaint(spanCenter: number, bandTop: number): void {
  paintSpanCenter = spanCenter;
  paintBandTop = bandTop;
  if (paintRaf) return;
  paintRaf = requestAnimationFrame(() => {
    paintRaf = 0;
    paintMinimapAt(paintSpanCenter, paintBandTop);
  });
}

function onPointerDown(e: PointerEvent): void {
  // Plain mode has no map; chunk mode requires one.
  if (!root || !thumb || root.hidden || (mode === 'chunk' && !map) || mode === null) return;
  e.preventDefault();
  try {
    root.setPointerCapture(e.pointerId);
  } catch {
    // No active pointer with this id (synthetic events) — drag still works
    // while the pointer stays over the bar; capture is an enhancement.
  }
  scrubbing = true;
  root.classList.add('scrubbing');
  // iOS can't give web pages real haptics; Android can — a tick on grab
  // approximates the native scrollbar's physical engage feel where possible.
  if (e.pointerType === 'touch') {
    (navigator as { vibrate?: (ms: number) => boolean }).vibrate?.(8);
  }
  if (mode === 'chunk') minimap?.show(); // no preview in plain mode (no node data)

  dragStartY = e.clientY;
  const isOnThumb = e.target === thumb;
  if (isOnThumb) {
    dragStartThumbTop = thumbTop;
  } else {
    // Track press: center the thumb on the press point and treat as a scrub.
    dragStartThumbTop = e.clientY - barTop - thumbH / 2;
    scrubTo(dragStartThumbTop);
  }
}

function onPointerMove(e: PointerEvent): void {
  if (scrubbing) {
    // 1:1 absolute tracking — the thumb follows the pointer, so you can fling to
    // the ends. Precise landing is via clicking the preview, not fine-dragging.
    scrubTo(dragStartThumbTop + (e.clientY - dragStartY));
    return;
  }
  if (hovering && map && mode === 'chunk') {
    // Hover preview without dragging: peek at the hovered position.
    const frac = trackH > 0 ? Math.min(1, Math.max(0, (e.clientY - barTop) / trackH)) : 0;
    const v = frac * map.totalHeight;
    schedulePaint(v, v);
  }
}

function onPointerUp(e: PointerEvent): void {
  if (!scrubbing) return;
  scrubbing = false;
  root?.classList.remove('scrubbing');
  try {
    root?.releasePointerCapture?.(e.pointerId);
  } catch {
    // capture was never established (see onPointerDown)
  }
  if (pendingIdx !== null && pendingV !== null) {
    void commitJump(pendingIdx, pendingV);
  }
  pendingIdx = null;
  pendingV = null;
  // Touch has no hover: pointerleave never fires after lift-off, so `hovering`
  // would stick true and the preview would never dismiss. Lift = done.
  if (e.pointerType === 'touch') hovering = false;
  if (!hovering) hideSoon();
  updateFade();
}

function onPointerEnter(e: PointerEvent): void {
  if (e.pointerType === 'touch') return; // no hover concept on touch — show only while scrubbing
  hovering = true;
  cancelHide();
  updateFade();
  if (root && !root.hidden && map) minimap?.show();
}

function onPointerLeave(): void {
  hovering = false;
  if (!scrubbing) hideSoon();
  updateFade();
}

/** Safety net (mobile especially): any press outside the bar + popup dismisses the preview. */
function onDocumentPointerDown(e: Event): void {
  const target = e.target;
  if (target instanceof Node && (root?.contains(target) || minimap?.contains(target))) return;
  hovering = false;
  canvasHover = false;
  cancelHide();
  if (!scrubbing) minimap?.hide();
  updateFade();
}

function paintMinimapAt(vSpanCenter: number, vBandTop: number = vSpanCenter): void {
  if (!minimap || !map) return;
  minimap.paint(map, vSpanCenter, vBandTop, viewportVirtualEstimate(), {
    barTop,
    barHeight: trackH,
    thumbTop,
    thumbHeight: thumbH,
  });
}

// ── jump execution ──────────────────────────────────────────────────────────

function neighborChunkIds(m: VirtualMap, chunkId: number): number[] {
  const ids = m.chunkIdsSorted;
  const i = ids.indexOf(chunkId);
  if (i < 0) return [chunkId];
  return ids.slice(Math.max(0, i - 1), Math.min(ids.length, i + 2));
}

/**
 * Jump the content to virtual position `vPos` (node index `idx` + intra-node
 * fraction) — single-flight with latest-wins queueing (a second commit can
 * NEVER overlap the first: loadChunkInternal has awaits between its
 * reservation and insert, and two interleaved window rebuilds would poison
 * currentlyLoadedChunks / the sentinel order).
 */
async function commitJump(idx: number, vPos: number): Promise<void> {
  if (!loader || !map || idx < 0 || idx >= map.nodeIds.length) {
    verbose.nav(`scrub commit skipped: no loader/map or idx ${idx} out of range`, SRC);
    return;
  }
  if (idx === lastCommittedIdx && lastCommittedV !== null && Math.abs(vPos - lastCommittedV) < 1) {
    verbose.nav(`scrub commit skipped: position already committed (idx ${idx})`, SRC);
    return;
  }
  if (isEditing()) {
    verbose.nav('scrub commit skipped: edit mode', SRC);
    return;
  }
  if (jumpInFlight) {
    verbose.nav(`scrub commit queued behind in-flight jump: idx ${idx}`, SRC);
    queuedJump = { idx, v: vPos };
    return;
  }
  jumpInFlight = true;
  const instance = loader;
  const generation = bindGeneration;
  const jumpMap = map;
  // Safety net mirroring refresh(): a wedged load must not leave scroll locked.
  const safety = setTimeout(() => instance.unlockScroll(), 5000);
  try {
    const nodeId = jumpMap.nodeIds[idx];
    const chunkId = jumpMap.chunkOf[idx];
    if (nodeId === undefined || chunkId === undefined) return;
    instance.lockScroll('scrollbar-scrub'); // blocks sentinels + scroll saves + prepend compensation

    const far = !instance.currentlyLoadedChunks.has(chunkId);
    verbose.nav(
      `scrub commit → node ${nodeId} (idx ${idx}, chunk ${chunkId}, ${far ? 'far: rebuild window' : 'near: already loaded'})`,
      SRC,
    );
    if (far) {
      // Far jump — internalNav's clear-path shape: rebuild the window around the
      // target. Legal here because the bar only exists in read mode (no caret /
      // unsaved-edit chunks to protect). A held selection lives in the DOM we
      // are about to remove — collapse it (the user chose to navigate away)
      // rather than silently refusing to move, which read as a dead scrollbar.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) sel.removeAllRanges();
      instance.container.querySelectorAll('[data-chunk-id]').forEach((el) => el.remove());
      instance.currentlyLoadedChunks.clear();
      const ids = neighborChunkIds(jumpMap, chunkId);
      await Promise.all(ids.map((id) => instance.loadChunk(id, 'down')));
      if (generation !== bindGeneration) return; // SPA nav mid-load — the new book owns the DOM
      instance.repositionSentinels();
    }

    const el = instance.container.querySelector<HTMLElement>(
      `[id="${CSS.escape(nodeId)}"]`,
    );
    if (el) {
      // Mid-node precision: convert the intra-node virtual offset into REAL
      // pixels via the rendered element's height (ratio 1 once measured), and
      // land that far INTO the node. Passing it through the header-offset
      // parameter keeps the helper's 100ms + image-load corrections aimed at
      // the same spot instead of fighting us back to the node top.
      const nodeVTop = jumpMap.offsets[idx] ?? vPos;
      const nodeVH = (jumpMap.offsets[idx + 1] ?? nodeVTop) - nodeVTop;
      const rectH = el.getBoundingClientRect().height;
      const intraReal =
        nodeVH > 0 && rectH > 0
          ? Math.min(Math.max(0, (vPos - nodeVTop) * (rectH / nodeVH)), Math.max(0, rectH - 1))
          : 0;
      scrollElementWithConsistentMethod(el, instance.scrollableParent, SCRUB_LAND_OFFSET - intraReal);
      lastCommittedIdx = idx;
      lastCommittedV = vPos;
    } else {
      verbose.nav(`customScrollbar: target node ${nodeId} not found after load`, SRC);
    }
  } catch (err) {
    log.error(`customScrollbar jump failed: ${err instanceof Error ? err.message : String(err)}`, SRC);
  } finally {
    clearTimeout(safety);
    instance.unlockScroll(); // schedules forceSavePosition(+250ms) → % display + resume update
    jumpInFlight = false;
    if (generation === bindGeneration) {
      // Belt-and-braces: bare loadChunk never trims; sentinel loads right after a
      // jump can momentarily exceed the budget.
      if (instance.currentlyLoadedChunks.size > MAX_LOADED_CHUNKS) {
        void trimWindow(instance, 'down').catch(() => {});
      }
      // Edge landing: make sure short chunks still cover the viewport.
      void import('../../lazyLoader/utilities/fillViewport')
        .then(({ fillViewport }) => fillViewport(instance))
        .catch(() => {});
    }
    if (queuedJump !== null) {
      const q = queuedJump;
      queuedJump = null;
      void commitJump(q.idx, q.v);
    }
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function addWindowListener(type: string, fn: EventListener): void {
  window.addEventListener(type, fn);
  windowListeners.push([type, fn]);
}

export function initCustomScrollbar(): void {
  ensureDom();

  // Dev-only inspection handle (smoke tests + "why didn't it move" console debugging).
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    (window as unknown as Record<string, unknown>).__customScrollbar = {
      get map() { return map; },
      get loader() { return loader; },
      get calibration() { return estPerRealEma; },
      get measuredCount() { return measuredCount(); },
    };
  }

  if (windowListeners.length === 0) {
    addWindowListener('resize', () => {
      // The arranger fires a `resize` right after loading a home/user collection
      // (homepageDisplayUnit) — the one reliable hook to bind the new loader.
      maybeRebind();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        resizeDebounce = null;
        updateGeometry();
        // Width/font changes alter charsPerLine — the estimates need a refresh.
        scheduleRebuild();
        if (!syncRaf) syncRaf = requestAnimationFrame(syncThumb);
      }, 150);
    });
    const modeChanged = () => {
      if (geometryRaf) cancelAnimationFrame(geometryRaf);
      geometryRaf = requestAnimationFrame(() => {
        geometryRaf = 0;
        updateGeometry();
        updateVisibility();
        if (!syncRaf) syncRaf = requestAnimationFrame(syncThumb);
      });
    };
    addWindowListener('paginatorstate', modeChanged);
    addWindowListener('readingmodechange', modeChanged);
    addWindowListener('backgroundDownloadComplete', () => scheduleRebuild(0));
    addWindowListener('pointerdown', onDocumentPointerDown);
    // contentUpdated fires only on a server-changed refresh (loadHyperText) —
    // a secondary rebind hook alongside the arranger's resize.
    addWindowListener('contentUpdated', () => maybeRebind());
  }

  // Every reader entry (full load or SPA nav): bind once the first chunk is in
  // the DOM — geometry and the node array need real content.
  pendingFirstChunkLoadedPromise
    ?.then(() => bindLoader())
    .catch(() => {});

  // Plain-DOM (home/user hero/feed) has no chunk promise — bind once layout is
  // ready so the scrollable wrapper is measurable. maybeRebind is a no-op if the
  // chunk promise above already bound a loader. A couple of retries cover the
  // wrapper becoming scrollable late (web-font swap, lava-lamp layout settle).
  requestAnimationFrame(() => maybeRebind());
  window.setTimeout(() => maybeRebind(), 500);
  window.setTimeout(() => maybeRebind(), 1500);
}

export function destroyCustomScrollbar(): void {
  unbindLoader();
  for (const [type, fn] of windowListeners) window.removeEventListener(type, fn);
  windowListeners = [];
  if (syncRaf) cancelAnimationFrame(syncRaf);
  syncRaf = 0;
  if (geometryRaf) cancelAnimationFrame(geometryRaf);
  geometryRaf = 0;
  if (paintRaf) cancelAnimationFrame(paintRaf);
  paintRaf = 0;
  cancelHide();
  canvasHover = false;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = null;
  if (resizeDebounce) clearTimeout(resizeDebounce);
  resizeDebounce = null;
  scrubbing = false;
  hovering = false;
  removeDom();
  verbose.init('customScrollbar destroyed', SRC);
}
