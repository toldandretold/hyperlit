/**
 * Chunk DOM windowing — keep the rendered chunk count bounded so a long scroll (or a long edit
 * session) doesn't accumulate hundreds of `.chunk` divs and slow the div editor.
 *
 * As the lazy loader appends/prepends chunks, `trimWindow` removes the chunk FARTHEST from travel
 * (scroll down → the lowest `data-chunk-id`; scroll up → the highest) once the loaded count exceeds
 * the budget. Removal is DOM-only — `instance.nodes` / IndexedDB are untouched, and deleting the id
 * from `currentlyLoadedChunks` re-enables the observer to re-render it instantly on scroll-back.
 *
 * Invariants preserved (see chunkWindowing.test.js): only END chunks are ever removed, so the
 * one-contiguous-block-between-the-sentinels invariant holds without sentinel surgery.
 *
 * Safety seams (all mandatory — a chunk is removed ONLY when every one passes):
 *  A. `setProgrammaticUpdateInProgress` around `.remove()`, cleared on the NEXT FRAME so the
 *     divEditor MutationObserver (async callback) still sees it set and doesn't mistake the removal
 *     for a user deletion.
 *  B. only ever remove a chunk that is FULLY off-screen (never a visible one) — this also makes the
 *     degenerate "many tiny chunks all fit on screen" case safe (nothing is off-screen → nothing
 *     removed) and prevents boundary thrash.
 *  C. never remove the chunk holding the caret.
 *  D. (edit mode) never remove a chunk with pending unsaved edits — the save path reads the LIVE DOM
 *     at flush, so removing it first would lose the edit. Let the debounce flush it; a later trim
 *     removes it safely.
 *  E. never trim while a selection / paste / chunk-overflow / user-deletion is in progress.
 */
import { captureScrollAnchor, restoreScrollAnchor } from '../../utilities/scrollAnchor';
import {
  setProgrammaticUpdateInProgress,
  chunkOverflowInProgress,
  userDeletionInProgress,
} from '../../utilities/operationState';
import { isSelectionDragActive } from '../../scrolling/selectionAutoScroll';
import { isPasteOperationActive } from '../../paste/pasteState';
import { getCurrentChunk } from '../../utilities/chunkState';
import { parseChunkId } from '../../indexedDB/types';

/** Max chunk divs kept in the DOM at once. Tunable; the buffer also keeps a removed end chunk far
 *  from the active sentinel so removal can't immediately re-trigger a reload. */
export const MAX_LOADED_CHUNKS = 7;

/** Match the IntersectionObserver's rootMargin so "off-screen" agrees with "won't reload yet". */
const OFFSCREEN_MARGIN = 150;

/** A selection that windowing must not disturb: an active drag, or a held non-collapsed selection. */
function selectionActive(): boolean {
  if (isSelectionDragActive()) return true;
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  return !!(sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed);
}

/** Ascending list of the chunk ids currently in the DOM. */
function loadedChunkIdsSorted(instance: any): number[] {
  return Array.from(instance.container.querySelectorAll('[data-chunk-id]'))
    .map((el: any) => parseChunkId(el.getAttribute('data-chunk-id')) as unknown as number)
    .sort((a: number, b: number) => a - b);
}

/**
 * Is the chunk div entirely above the scrollport top OR entirely below its bottom, by > margin?
 * `scrollableParent` is either `window` or a scrollable element (`.reader-content-wrapper`).
 *
 * PAGINATED MODE NOTE: this test is deliberately vertical-only. In paginated mode
 * (instance.pagingMode, horizontal multicol layout) every chunk's bounding box spans the
 * full page-height band, so no chunk ever reads "fully off-screen" — trimWindow is
 * harmlessly INERT while paginated and the DOM window grows for the session. That is the
 * accepted tradeoff (a horizontal trim would shift page geometry); if reflow jank ever
 * shows past ~15 loaded chunks, add a paginator-side horizontal trim instead of widening
 * this test.
 */
function isChunkFullyOffscreen(chunkEl: HTMLElement, scrollableParent: any): boolean {
  const r = chunkEl.getBoundingClientRect();
  let top: number;
  let bottom: number;
  if (scrollableParent === window || !scrollableParent || typeof scrollableParent.getBoundingClientRect !== 'function') {
    top = 0;
    bottom = window.innerHeight;
  } else {
    const c = scrollableParent.getBoundingClientRect();
    top = c.top;
    bottom = c.bottom;
  }
  return r.bottom < top - OFFSCREEN_MARGIN || r.top > bottom + OFFSCREEN_MARGIN;
}

/**
 * Inverse of `isChunkFullyOffscreen`, for a sentinel: is the element inside the scrollport
 * (± OFFSCREEN_MARGIN, the same band the IntersectionObserver uses)? `fillViewport` uses this to
 * decide whether a sentinel is still "in view" and the next/prev chunk should keep loading.
 */
export function isWithinViewport(el: HTMLElement, scrollableParent: any): boolean {
  return !isChunkFullyOffscreen(el, scrollableParent);
}

/** Child node ids (= startLine/LineId strings) of a chunk element. */
function chunkChildIds(chunkEl: Element): string[] {
  return Array.from(chunkEl.children)
    .map((c) => (c as HTMLElement).id)
    .filter((id) => id !== '');
}

/**
 * Remove one chunk's DOM (suppressing the editor save-path + preserving the visual scroll
 * position), and drop it from `currentlyLoadedChunks` so it can re-load on scroll-back.
 */
export function removeChunk(instance: any, chunkId: number): void {
  const el = instance.container.querySelector(`[data-chunk-id="${chunkId}"]`);
  if (!el) {
    instance.currentlyLoadedChunks.delete(chunkId);
    return;
  }
  // Anchor on the first VISIBLE element so removing content above the viewport doesn't jump.
  const anchor = captureScrollAnchor(instance.scrollableParent);
  setProgrammaticUpdateInProgress(true);
  try {
    el.remove();
    instance.currentlyLoadedChunks.delete(chunkId);
  } finally {
    // A. Clear on the NEXT FRAME, not synchronously: the divEditor MutationObserver callback is
    //    async (microtask after the mutation) and reads the flag at its top. Clearing it now would
    //    let that callback run with the flag already false → our removal misread as a user deletion.
    //    Mirrors hyperlights/deletion.ts reprocess.
    requestAnimationFrame(() => setProgrammaticUpdateInProgress(false));
  }
  if (anchor?.element?.isConnected) {
    restoreScrollAnchor(instance.scrollableParent, anchor);
  }
}

/**
 * Trim the loaded window back to MAX_LOADED_CHUNKS by removing the chunk farthest from travel.
 * Removes ONLY from the far end, and STOPS as soon as that chunk isn't safely removable (visible /
 * holds the caret / has pending edits) — never reaching into the interior. Async only to query the
 * editor's pending-saves in edit mode.
 */
export async function trimWindow(instance: any, direction: 'up' | 'down'): Promise<void> {
  // E. Don't window while another routine owns the DOM, or mid-selection (copy/cut, read or edit).
  if (isPasteOperationActive() || chunkOverflowInProgress || userDeletionInProgress) return;
  if (selectionActive()) return;

  const caretChunk = getCurrentChunk(); // the caret's data-chunk-id string, or null

  // D. In edit mode, the chunk holding an unsaved edit must not be removed (save reads the live DOM
  //    at flush). Query the queue's pending node ids once (dynamic import avoids a static
  //    lazyLoader↔divEditor cycle; read mode skips it entirely).
  let pendingNodeIds: Set<string> = new Set();
  if ((window as any).editMode) {
    try {
      const { getPendingSaveNodeIds } = await import('../../divEditor/index');
      pendingNodeIds = getPendingSaveNodeIds();
    } catch {
      // accessor unavailable → fall through; the off-screen + caret guards still protect us.
    }
  }

  let ids = loadedChunkIdsSorted(instance);
  while (ids.length > MAX_LOADED_CHUNKS) {
    const victim = direction === 'down' ? ids[0] : ids[ids.length - 1];
    if (victim === undefined) break;

    const chunkEl = instance.container.querySelector(`[data-chunk-id="${victim}"]`);
    if (!chunkEl) break;

    // C. caret chunk — keep it.
    if (caretChunk !== null && String(victim) === caretChunk) break;
    // B. only trim fully off-screen chunks (also: tiny-chunk catastrophe → all visible → nothing removed).
    if (!isChunkFullyOffscreen(chunkEl as HTMLElement, instance.scrollableParent)) break;
    // D. pending unsaved edits — let the debounce flush; a later trim removes it.
    if (pendingNodeIds.size > 0 && chunkChildIds(chunkEl).some((id) => pendingNodeIds.has(id))) break;

    removeChunk(instance, victim);
    const next = loadedChunkIdsSorted(instance);
    if (next.length >= ids.length) break; // safety: nothing removed → avoid an infinite loop
    ids = next;
  }
}
