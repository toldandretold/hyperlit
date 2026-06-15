/**
 * currentLazyLoaderState — zero-import leaf holding the active lazy-loader singleton.
 *
 * The lazy loader is shared mutable state read by many layers (scrolling, hypercites,
 * navigation, …). It lives in a leaf (the [[circular-import-tdz-leaf-state]] idiom, like
 * navState / cascadeOriginState / containerState) so ANY module can import it STATICALLY
 * and downward — no cycle, no dynamic-import cycle-breaker. lazyLoaderRegistry is the only
 * writer (via setCurrentLazyLoader); everyone else reads the live `currentLazyLoader` binding.
 */

export let currentLazyLoader: any = null;

export function setCurrentLazyLoader(loader: any): void {
  currentLazyLoader = loader;
}
