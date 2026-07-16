/**
 * scrolling/userScrollDetection — detect when the user is actively scrolling so
 * scroll restoration / navigation don't fight manual input. Reads/writes the
 * shared navState leaf.
 */
import { verbose } from '../utilities/logger';
import { userScrollState, navTimers } from './navState';

function detectUserScrollStart(event?: any): void {
  // Don't treat navigation scrolls as user scrolls
  if (userScrollState.isNavigating) {
    return;
  }

  // For touch events, only mark as scrolling if there's actual movement
  if (event && event.type === 'touchstart') {
    // Record initial touch position, but don't mark as scrolling yet
    userScrollState.touchStartY = event.touches[0].clientY;
    userScrollState.touchStartX = event.touches[0].clientX;
    return; // Don't mark as scrolling on initial touch
  }

  if (event && event.type === 'touchmove') {
    // Only mark as scrolling if touch moved significantly (more than 10px)
    if (userScrollState.touchStartY !== null && userScrollState.touchStartX !== null) {
      const deltaY = Math.abs(event.touches[0].clientY - userScrollState.touchStartY);
      const deltaX = Math.abs(event.touches[0].clientX - userScrollState.touchStartX);

      if (deltaY < 10 && deltaX < 10) {
        // Not enough movement - probably a tap, not a scroll
        return;
      }
    }
  }

  // Log only the false→true transition — this handler fires on every raw
  // scroll/wheel/touchmove event, so an unconditional log floods the console.
  if (!userScrollState.isScrolling) {
    verbose.content(`USER SCROLL DETECTED - Disabling all scroll restoration for 1 second`, 'scrolling/userScrollDetection');
  }

  userScrollState.isScrolling = true;
  userScrollState.lastUserScrollTime = Date.now();

  // Intent gestures only (wheel / touchmove-past-threshold): the link-click
  // block keys off THESE, not bare `scroll` events — the browser scrolling a
  // clicked link into view fires `scroll` right before the click lands, and
  // blocking on that made deliberate clicks silently dead. (touchstart
  // returned above; a `scroll` event has no gesture semantics.)
  if (event && (event.type === 'wheel' || event.type === 'touchmove')) {
    userScrollState.lastGestureScrollTime = Date.now();
  }

  // Clear any existing timeout
  if (userScrollState.scrollTimeout) {
    clearTimeout(userScrollState.scrollTimeout);
  }

  // Reset after 1 second of no scroll events (reduced from 2 seconds)
  userScrollState.scrollTimeout = setTimeout(() => {
    userScrollState.isScrolling = false;
    userScrollState.touchStartY = null;
    userScrollState.touchStartX = null;
    verbose.content(`USER SCROLL ENDED - Re-enabling scroll restoration`, 'scrolling/userScrollDetection');
  }, 1000);
}

export function isUserCurrentlyScrolling(): boolean {
  const timeSinceLastScroll = Date.now() - userScrollState.lastUserScrollTime;
  return userScrollState.isScrolling || timeSinceLastScroll < 2000;
}

// Separate check for blocking link clicks - MUCH tighter timing
// Allows: scroll → stop → immediately click
export function isActivelyScrollingForLinkBlock(): boolean {
  // Only block if the user GESTURED a scroll (wheel / touchmove) right now —
  // the accidental-tap-during-momentum case this guard exists for. Bare
  // `scroll` events deliberately don't count: the browser scrolling a click
  // target into view fires one immediately before the click, and blocking on
  // it made deliberate clicks on below-the-fold links silently dead (the
  // home→reader card-click e2e failure). 200ms buffer catches momentum tail.
  const timeSinceGesture = Date.now() - userScrollState.lastGestureScrollTime;
  return userScrollState.isScrolling && timeSinceGesture < 200;
}

export function shouldSkipScrollRestoration(reason = "user scrolling"): boolean {
  const skip = isUserCurrentlyScrolling();
  if (skip) {
    verbose.nav(`SKIP RESTORATION: ${reason} - user was scrolling ${Date.now() - userScrollState.lastUserScrollTime}ms ago`, 'scrolling/userScrollDetection');
  }
  return skip;
}

/**
 * Cancel any pending navigation cleanup timer
 * Used by search toolbar to prevent navigation from interfering with keyboard positioning
 */
export function cancelPendingNavigationCleanup(): void {
  if (navTimers.pendingNavigationCleanupTimer) {
    clearTimeout(navTimers.pendingNavigationCleanupTimer);
    navTimers.pendingNavigationCleanupTimer = null;
  }
}

/**
 * Mark scroll state as navigating to prevent scroll events from being detected as user scrolls.
 * Used by refresh() to prevent content reloading from triggering "user scroll" detection.
 */
export function setNavigatingState(isNavigating: boolean): void {
  userScrollState.isNavigating = isNavigating;
}

// Clear all stale scroll tracking from the previous book
export function resetUserScrollState(): void {
  userScrollState.isScrolling = false;
  userScrollState.lastUserScrollTime = 0;
  userScrollState.isNavigating = false;
  if (userScrollState.scrollTimeout) {
    clearTimeout(userScrollState.scrollTimeout);
    userScrollState.scrollTimeout = null;
  }
  userScrollState.touchStartY = null;
  userScrollState.touchStartX = null;
}

// Set up user scroll detection for a container
export function setupUserScrollDetection(scrollableContainer: any): void {
  if (!scrollableContainer) {
    console.warn("No scrollable container provided for user scroll detection");
    return;
  }

  verbose.init(`User scroll detection for: ${scrollableContainer.className || scrollableContainer.id}`, 'scrolling/userScrollDetection');

  // User scroll detection events
  const scrollEvents = ['scroll', 'wheel', 'touchstart', 'touchmove'];

  scrollEvents.forEach(eventType => {
    scrollableContainer.addEventListener(eventType, detectUserScrollStart, { passive: true });
  });

  // Also detect keyboard navigation (arrow keys, page up/down, etc.)
  window.addEventListener('keydown', (event) => {
    const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Space'];
    if (scrollKeys.includes(event.key)) {
      detectUserScrollStart();
    }
  }, { passive: true } as any);

}
