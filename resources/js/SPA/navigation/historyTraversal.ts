/**
 * "Did we arrive on this page by walking the browser history (back/forward)?"
 *
 * The hero pages (home, /j/{slug}, /a/{slug}) boot to the hero on a FRESH
 * visit or a reload, but a back/forward return must put the reader back where
 * they were: the feed tab that was open on that history entry
 * (history.state.userPageActiveTab), at the scroll position they left it.
 * homepageHero used to wipe that per-entry state on EVERY init, so back from a
 * book always landed on the hero.
 *
 * Two ways a traversal reaches a page init, hence two signals:
 *   - SPA popstate: LinkNavigationHandler brackets its handling with
 *     begin/endPopstateTraversal, and the structure init runs inside it.
 *   - Full document load via back/forward (the entry was left by a native
 *     navigation and bfcache missed): the Navigation Timing type. That type
 *     describes how the DOCUMENT was loaded and never changes afterwards, so
 *     it only counts until the first SPA navigation (noteSpaNavigation) —
 *     otherwise a tab once loaded via back would read as "traversal" forever.
 *
 * A zero-import leaf (state only), so any component can ask without a cycle.
 */

let popstateDepth = 0;
let spaNavigated = false;

/** LinkNavigationHandler: a popstate is being handled (pair with end). */
export function beginPopstateTraversal(): void {
  popstateDepth++;
  spaNavigated = true;
}

export function endPopstateTraversal(): void {
  popstateDepth = Math.max(0, popstateDepth - 1);
}

/** Any in-page navigation: the document's own load type no longer applies. */
export function noteSpaNavigation(): void {
  spaNavigated = true;
}

export function isHistoryTraversal(): boolean {
  if (popstateDepth > 0) return true;
  if (spaNavigated) return false;
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === 'back_forward';
  } catch {
    return false;
  }
}

/** Test seam. */
export function _resetHistoryTraversalForTests(): void {
  popstateDepth = 0;
  spaNavigated = false;
}
