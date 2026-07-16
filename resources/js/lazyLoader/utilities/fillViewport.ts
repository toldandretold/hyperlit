/**
 * fillViewport — guarantee the viewport is covered regardless of chunk SIZE.
 *
 * The IntersectionObserver trigger (lazyLoader/index.ts) assumes a chunk is TALLER than the viewport:
 * a freshly-loaded chunk pushes the far sentinel out of view, so the next load only re-fires when the
 * user scrolls it back. That assumption breaks two ways:
 *   - SHORT chunks (a small book, or a chunk whose nodes were deleted): both sentinels can sit on
 *     screen at once, and an observer that only fires on intersection *transitions* can stall.
 *   - EDGE LANDING: `internalNav` loads target±1 with the observer BLOCKED during nav; if the target
 *     sits at a chunk edge and target±1 fit on screen, after nav the sentinel is in view but no
 *     transition occurs → nothing below to scroll into → the "scroll up then down to unstick" bug.
 *
 * This routine is transition-INDEPENDENT: while a sentinel is still within the scrollport (+margin)
 * and a loadable neighbour exists, it loads it and re-measures, until both sentinels are pushed out
 * of view OR the manifest is exhausted. It reuses the instance's own `loadNextChunk`/`loadPreviousChunk`
 * (= `loadNextChunkFixed`/`loadPreviousChunkFixed`, which resolve the neighbour id from the manifest,
 * render, reposition the sentinels, and trim). Termination: a pass that loads nothing breaks the loop
 * (manifest end / chunk 0 / already filled); `maxIterations` is a backstop against a bug.
 */
import { parseChunkId } from '../../indexedDB/types';
import { isWithinViewport } from './windowChunks';

function firstChunkEl(container: any): Element | null {
  return container.querySelector('[data-chunk-id]');
}

function lastChunkEl(container: any): Element | null {
  const all = container.querySelectorAll('[data-chunk-id]');
  return all.length ? all[all.length - 1] : null;
}

export async function fillViewport(instance: any, maxIterations = 100): Promise<void> {
  // Paginated mode: isWithinViewport() only tests VERTICAL offsets, and in a horizontal
  // column layout every sentinel reads as "in view" forever — this loop would runaway-load
  // up to maxIterations chunks. The paginator does its own filling from page-turn logic.
  if (instance?.pagingMode) return;
  // Re-entrancy guard: the observer fires repeatedly; only one fill loop at a time.
  if (!instance || !instance.container || instance._fillingViewport) return;
  instance._fillingViewport = true;
  try {
    const parent = instance.scrollableParent;

    for (let i = 0; i < maxIterations; i++) {
      let progressed = false;

      // BELOW: bottom sentinel still in view → load the next chunk (no-ops at the manifest end).
      if (instance.bottomSentinel && isWithinViewport(instance.bottomSentinel, parent) && instance.loadNextChunk) {
        const before = instance.currentlyLoadedChunks.size;
        const lastEl = lastChunkEl(instance.container);
        if (lastEl) {
          await instance.loadNextChunk(parseChunkId(lastEl.getAttribute('data-chunk-id')!), instance);
          if (instance.currentlyLoadedChunks.size > before) progressed = true;
        }
      }

      // ABOVE: top sentinel still in view → load the previous chunk (no-ops at chunk 0).
      if (instance.topSentinel && isWithinViewport(instance.topSentinel, parent) && instance.loadPreviousChunk) {
        const before = instance.currentlyLoadedChunks.size;
        const firstEl = firstChunkEl(instance.container);
        if (firstEl) {
          await instance.loadPreviousChunk(parseChunkId(firstEl.getAttribute('data-chunk-id')!), instance);
          if (instance.currentlyLoadedChunks.size > before) progressed = true;
        }
      }

      if (!progressed) break; // viewport filled, or no loadable neighbour in either direction
    }
  } finally {
    instance._fillingViewport = false;
  }
}
