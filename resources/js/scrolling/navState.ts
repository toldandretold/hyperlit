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

// Pending navigation cleanup timer, held in an object so it can be reassigned
// from any module by reference.
export const navTimers: { pendingNavigationCleanupTimer: ReturnType<typeof setTimeout> | null } = {
  pendingNavigationCleanupTimer: null,
};
