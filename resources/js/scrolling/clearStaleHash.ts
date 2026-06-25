/**
 * scrolling/clearStaleHash — strip a stale internal-nav hash from the URL once the
 * user has scrolled away from the target.
 *
 * Why: navigating to a hypercite / highlight / paragraph leaves a `#hypercite_…`,
 * `#HL_…` or `#<numeric>` hash in the URL. That hash is never removed, so a page
 * refresh re-reads it as a fresh explicit target (restore.ts:120, 138-142) and jumps
 * back to it instead of resuming at the user's current scroll position — the in-memory
 * `navigatedHashes` guard that suppresses it within a session is wiped on reload.
 *
 * Near-leaf module (only imports the navState leaf), kept light so it can be called
 * cheaply from the throttled scroll-save path (lazyLoader forceSavePosition).
 */

import { navigatedHashes } from './navState';

/** Matches the internal-navigation target classes used by restore.ts (decimal-aware). */
function isInternalNavTarget(id: string): boolean {
  return id.startsWith('hypercite_') || id.startsWith('HL_') || /^\d+(\.\d+)?$/.test(id);
}

/**
 * If the URL carries an internal-nav hash and no hyperlit container is open, strip the
 * hash from the URL while preserving `history.state` (so popstate / container-chain
 * rebuild logic is untouched). Call this when a genuine user scroll has moved the saved
 * reading position — i.e. the user has scrolled away from the navigated-to target.
 */
export function clearInternalNavHashIfScrolledAway(): void {
  const hashId = window.location.hash.substring(1);
  if (!hashId || !isInternalNavTarget(hashId)) {
    return;
  }

  // While a container is open the hash is part of the container-stack URL contract
  // (hyperlitContainer/stack.ts syncStackToHistoryState) — removing it would desync
  // back/forward. Leave it alone until the container closes.
  if (document.body.classList.contains('hyperlit-container-open')) {
    return;
  }

  // Preserve history.state (never null) so popstate handlers keep their container state.
  const cleanUrl = window.location.pathname + window.location.search;
  history.replaceState(history.state, '', cleanUrl);

  // Belt-and-suspenders for the current session: even if the hash reappears, treat it
  // as already navigated so restore.ts falls back to the saved scroll position.
  navigatedHashes.add(hashId);
}
