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

// The resume-vs-jump decision used to live here as two ephemeral signals — an in-memory
// `navigatedHashes` Set and a sessionStorage `scrolled-away` marker. Both were retired: they only
// survived a single session, so a reader who returned LATER (restart / another device) was yanked
// back to a residual hash. The durable causal replacement is `savedAt` (reading-position payload)
// vs per-target `navigatedAt` (scrolling/navStamp) — see scrolling/README.md.

// Pending navigation cleanup timer, held in an object so it can be reassigned
// from any module by reference.
export const navTimers: { pendingNavigationCleanupTimer: ReturnType<typeof setTimeout> | null } = {
  pendingNavigationCleanupTimer: null,
};
