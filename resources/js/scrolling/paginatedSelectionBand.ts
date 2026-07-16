/**
 * paginatedSelectionBand — draw the text-selection highlight ourselves in
 * paginated reading mode.
 *
 * Why this exists: pages mode lays `.main-content` out as CSS multi-columns and
 * shows a "page" by scrolling the wrapper horizontally so one off-screen overflow
 * column comes into view (scrolling/paginator.ts). iOS Safari's NATIVE selection
 * painter is unreliable for content sitting in a scrolled multicol overflow — the
 * selection is live and highlights create fine, but the blue band frequently isn't
 * PAINTED, so the reader selects blind. (An explicit `::selection` colour only
 * papered over it non-deterministically.) The SAME layout that breaks the native
 * painter is why the paginator scrolls instead of transforms: transformed multicol
 * fragments return broken CDP coordinates. Crucially, `range.getClientRects()`
 * still returns CORRECT viewport rects for on-page content (the paginator relies on
 * that for `pageOfElement`), so we can draw the band ourselves and land it exactly.
 *
 * What it does: a single `position:fixed`, `pointer-events:none` layer holds one
 * `.pg-sel-band` div per selection client-rect. On `selectionchange` (rAF-throttled)
 * we re-read the live selection's rects and reposition the pool; we clear on an
 * empty/collapsed selection, when the paginator isn't engaged (scroll mode's native
 * selection is fine — untouched), and on a wrapper scroll (a page turn / chunk
 * reflow makes the rects stale — the next selectionchange redraws if still selected).
 * `getClientRects()` are viewport coordinates, so `position:fixed` children need no
 * scroll math.
 *
 * Listener-bearing component → registered via ButtonRegistry (components/utilities/
 * registerComponents.ts) for pages ['reader'], NOT a @vite side-effect or a top-level
 * global singleton. Document-delegated singleton: attach once, survive SPA nav; re-init
 * just clears stale bands.
 */

import { isPaginatorEngaged } from './paginator';

/**
 * The transform-paging experiment (an attempt to restore native iOS selection)
 * failed — native selection painting is broken by the multicol layout itself,
 * independent of scroll-vs-transform, so we draw the band ourselves. This is the
 * same overlay-from-getClientRects technique foliate-js / epub.js use for
 * highlights, since native selection in multicol is a known WebKit limitation.
 */
const BAND_ENABLED = true;

const LAYER_ID = 'pg-selection-layer';
const BAND_CLASS = 'pg-sel-band';

let layer: HTMLElement | null = null;
let bands: HTMLElement[] = [];
let selectionHandler: (() => void) | null = null;
let scrollHandler: (() => void) | null = null;
let rafId = 0;
let initialized = false;

/** The paginated reader's horizontal scroller (only present in reader pages mode). */
function paginatedWrapper(): HTMLElement | null {
  const w = document.querySelector<HTMLElement>('.reader-content-wrapper.paginated-active');
  return w;
}

function ensureLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  layer = document.getElementById(LAYER_ID);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    document.body.appendChild(layer);
  }
  return layer;
}

/** Hide every band without discarding the pool (cheap; avoids per-clear churn). */
function clearBands(): void {
  for (const b of bands) b.style.display = 'none';
}

/** Grow/shrink the band pool to `n` and return the slice to use. */
function bandPool(n: number): HTMLElement[] {
  const host = ensureLayer();
  while (bands.length < n) {
    const b = document.createElement('div');
    b.className = BAND_CLASS;
    host.appendChild(b);
    bands.push(b);
  }
  return bands;
}

/** Is `node` inside the paginated reading content (vs. a container/annotation/etc.)? */
function inReaderMain(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return Boolean(el?.closest('.reader-content-wrapper.paginated-active .main-content'));
}

function draw(): void {
  rafId = 0;
  // Scroll mode / not paginated → native selection is fine, leave everything alone.
  if (!isPaginatorEngaged() || !paginatedWrapper()) { clearBands(); return; }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { clearBands(); return; }

  const range = sel.getRangeAt(0);
  // Only paint selections inside the paginated reading text (not the container editor,
  // toolbars, or annotation fields — those live in normally-flowed, natively-painted DOM).
  if (!inReaderMain(range.commonAncestorContainer)) { clearBands(); return; }

  const rects = range.getClientRects();
  if (rects.length === 0) { clearBands(); return; }

  const pool = bandPool(rects.length);
  for (let i = 0; i < pool.length; i++) {
    const b = pool[i];
    if (!b) continue;
    const r = i < rects.length ? rects.item(i) : null;
    // Skip absent / zero-area rects (collapsed line boxes) — nothing to paint.
    if (!r || r.width <= 0 || r.height <= 0) { b.style.display = 'none'; continue; }
    b.style.display = 'block';
    b.style.left = `${r.left}px`;
    b.style.top = `${r.top}px`;
    b.style.width = `${r.width}px`;
    b.style.height = `${r.height}px`;
  }
}

function scheduleDraw(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(draw);
}

export function initPaginatedSelectionBand(): void {
  // ButtonRegistry re-runs init on every reader entry. Document/window listeners survive
  // SPA nav, so attach once and just clear any stale bands on re-entry.
  clearBands();
  if (!BAND_ENABLED) return;
  if (initialized) return;

  selectionHandler = () => scheduleDraw();
  document.addEventListener('selectionchange', selectionHandler);

  // A page turn / chunk-window reflow scrolls the wrapper and moves the selected text;
  // the drawn rects go stale, so clear immediately (capture phase — reader scroll events
  // don't bubble). The next selectionchange repaints if a selection still exists.
  scrollHandler = () => { clearBands(); };
  document.addEventListener('scroll', scrollHandler, { capture: true, passive: true });

  initialized = true;
}

export function destroyPaginatedSelectionBand(): void {
  // Keep the document/window listeners alive across SPA nav (inert outside pages mode);
  // just clear any painted bands so the next reader entry starts clean.
  clearBands();
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}
