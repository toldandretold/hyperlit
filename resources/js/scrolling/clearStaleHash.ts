/**
 * scrolling/clearStaleHash — remember that the user has scrolled away from an internal-nav
 * hash target, so a later REFRESH resumes their reading position instead of re-jumping to it.
 *
 * Why: navigating to a hypercite / highlight / paragraph leaves a `#hypercite_…`, `#HL_…` or
 * `#<numeric>` hash in the URL. On a page refresh that hash is re-read as a fresh explicit
 * target (restore.ts) and jumps back to it — the in-memory `navigatedHashes` guard that
 * suppresses it within a session is wiped on reload.
 *
 * IMPORTANT: we must NOT strip the hash from the URL to fix this — `history.replaceState`
 * mutates the history ENTRY, so back/forward to it would lose the target (you'd land at the
 * top instead of the hypercite). Instead we persist a "scrolled away from this hash" marker in
 * sessionStorage (survives the same-tab refresh); `restoreScrollPosition` consults it and resumes
 * the saved position on REFRESH while the hash stays in the URL for history navigation.
 *
 * Near-leaf module (only imports the navState leaf), kept light so it can be called cheaply from
 * the throttled scroll-save path (lazyLoader forceSavePosition).
 */

import { markHashScrolledAway } from './navState';

/** Matches the internal-navigation target classes used by restore.ts (decimal-aware). */
function isInternalNavTarget(id: string): boolean {
  return id.startsWith('hypercite_') || id.startsWith('HL_') || /^\d+(\.\d+)?$/.test(id);
}

/**
 * Mark the URL's internal-nav hash as "scrolled away from" (so a refresh resumes the reading
 * position, not the hash). Call this when a genuine user scroll has moved the saved reading
 * position. Does NOT mutate the URL — back/forward must keep the hash to navigate to it.
 */
export function markInternalNavHashScrolledAway(): void {
  const hashId = window.location.hash.substring(1);
  if (!hashId || !isInternalNavTarget(hashId)) {
    return;
  }

  // While a container is open the hash is the container-stack's anchor (restored via ?cs=N) —
  // the user hasn't "scrolled away" from it in the main reader, so don't mark it.
  if (document.body.classList.contains('hyperlit-container-open')) {
    return;
  }

  markHashScrolledAway(hashId);
}
