export let pendingFirstChunkLoadedPromise: Promise<void> | undefined;
let firstChunkLoadedResolver: (() => void) | null;

export function resolveFirstChunkPromise() {
  if (firstChunkLoadedResolver && typeof firstChunkLoadedResolver === 'function') {
    firstChunkLoadedResolver();
    firstChunkLoadedResolver = null; // Clear it after use
  } else {
    // Set a flag to resolve it immediately when the promise is created
    (window as any)._resolveFirstChunkWhenReady = true;
  }
}

export function resetFirstChunkPromise() {
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
