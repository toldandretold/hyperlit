/**
 * scrolling — navigation & scroll-restoration orchestrator (the READ side of
 * scroll; lazyLoader owns the WRITE side). Formerly the top-level scrolling.js.
 *
 * Barrel re-exporting the public surface. Decomposed into:
 *   navState (leaf) · navOverlay · userScrollDetection · scrollHelpers ·
 *   internalNav · restore.
 *
 * Back-edges to hyperlights / hypercites / lazyLoaderFactory / initializePage are
 * dynamic imports inside the modules, so this folder's static graph is acyclic.
 */
import { navigatedHashes } from './navState';

export { restoreScrollPosition } from './restore';
export { navigateToInternalId } from './internalNav';
export { scrollElementIntoMainContent, isValidContentElement } from './scrollHelpers';
export { showNavigationLoading, hideNavigationLoading, restoreNavigationOverlayIfNeeded } from './navOverlay';
export {
  isUserCurrentlyScrolling,
  isActivelyScrollingForLinkBlock,
  shouldSkipScrollRestoration,
  cancelPendingNavigationCleanup,
  setNavigatingState,
  resetUserScrollState,
  setupUserScrollDetection,
} from './userScrollDetection';

// Cascade-origin state lives in a zero-import leaf module (navigation/cascadeOriginState)
// so it can't land in the TDZ mid circular-import. Re-exported for back-compat with
// existing `import { … } from './scrolling'` callers.
export {
  getCascadeOriginId,
  setCascadeOriginId,
  clearCascadeOriginId,
} from '../SPA/navigation/cascadeOriginState.js';

/**
 * Clear navigated hashes (called on popstate so back/forward re-navigates)
 */
export function clearNavigatedHashes(): void {
  navigatedHashes.clear();
}
