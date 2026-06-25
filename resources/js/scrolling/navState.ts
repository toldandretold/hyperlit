/**
 * scrolling/navState — zero-import leaf holding the mutable scroll/navigation
 * state shared across the scrolling modules.
 *
 * Kept import-free so it can never land in the Temporal Dead Zone when
 * scrolling is reached mid circular-import (see the [[circular-import-tdz-leaf-state]]
 * pattern). Everyone reads/writes these objects by reference.
 */

export interface UserScrollState {
  isScrolling: boolean;
  lastUserScrollTime: number;
  scrollTimeout: ReturnType<typeof setTimeout> | null;
  /** Flag to ignore navigation-driven scrolls (so they aren't read as user scrolls). */
  isNavigating: boolean;
  touchStartY: number | null;
  touchStartX: number | null;
}

// Global scroll state management to prevent restoration interference
export const userScrollState: UserScrollState = {
  isScrolling: false,
  lastUserScrollTime: 0,
  scrollTimeout: null,
  isNavigating: false,
  touchStartY: null,
  touchStartX: null,
};

// Track hashes we've already navigated to during THIS page session.
// Module-level (not history.state) so it resets on page reload, allowing fresh
// page loads to always navigate to the URL hash.
export const navigatedHashes = new Set<string>();

// Hashes the user has SCROLLED AWAY from, persisted in sessionStorage so the signal survives a
// same-tab refresh. Lets restoreScrollPosition resume the reading position on REFRESH instead of
// re-jumping to a deep-link hash — WITHOUT stripping the hash from the URL (which would corrupt
// back/forward to that entry). Written by scrolling/clearStaleHash on scroll-away, read by
// scrolling/restore, cleared by scrolling/internalNav when we deliberately navigate to the hash.
const SCROLLED_AWAY_KEY = 'hyperlit_scrolled_away_hashes';

function readScrolledAwayHashes(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SCROLLED_AWAY_KEY);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set<string>();
  }
}

export function markHashScrolledAway(hashId: string): void {
  try {
    const set = readScrolledAwayHashes();
    if (set.has(hashId)) return;
    set.add(hashId);
    sessionStorage.setItem(SCROLLED_AWAY_KEY, JSON.stringify([...set]));
  } catch {
    /* sessionStorage unavailable — best effort */
  }
}

export function unmarkHashScrolledAway(hashId: string): void {
  try {
    const set = readScrolledAwayHashes();
    if (!set.delete(hashId)) return;
    sessionStorage.setItem(SCROLLED_AWAY_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function hasScrolledAwayFromHash(hashId: string): boolean {
  return readScrolledAwayHashes().has(hashId);
}

// Pending navigation cleanup timer, held in an object so it can be reassigned
// from any module by reference.
export const navTimers: { pendingNavigationCleanupTimer: ReturnType<typeof setTimeout> | null } = {
  pendingNavigationCleanupTimer: null,
};
