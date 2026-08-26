// Zero-import-leaf forensics (scrollTrace is itself a leaf): the promise's
// lifecycle gates the boot scroll restore, and a boot where it never resolves
// strands the reader at the top of the book with no trace of why (the Slow-3G
// reload storm). Flag-gated, free when off.
import { recordNavDecision } from '../scrolling/scrollTrace';

export let pendingFirstChunkLoadedPromise: Promise<void> | undefined;
let firstChunkLoadedResolver: (() => void) | null;

export function resolveFirstChunkPromise() {
  recordNavDecision({ phase: 'first-chunk-resolve', hadResolver: !!firstChunkLoadedResolver });
  if (firstChunkLoadedResolver && typeof firstChunkLoadedResolver === 'function') {
    firstChunkLoadedResolver();
    firstChunkLoadedResolver = null; // Clear it after use
  } else {
    // Set a flag to resolve it immediately when the promise is created
    (window as any)._resolveFirstChunkWhenReady = true;
  }
}

export function resetFirstChunkPromise() {
    recordNavDecision({ phase: 'first-chunk-reset', pendingEarlyResolve: !!(window as any)._resolveFirstChunkWhenReady });
    pendingFirstChunkLoadedPromise = new Promise<void>(resolve => {
        firstChunkLoadedResolver = resolve;

        // ✅ If we were asked to resolve immediately, do it now
        if ((window as any)._resolveFirstChunkWhenReady) {
            resolve();
            (window as any)._resolveFirstChunkWhenReady = false;
        }
    });
}

export function getFirstChunkLoadedResolver(): (() => void) | null {
  return firstChunkLoadedResolver;
}
