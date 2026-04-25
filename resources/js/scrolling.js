// In scrolling.js

import { verbose } from './utilities/logger.js';
import { NavigationCompletionBarrier, NavigationProcess } from './navigation/NavigationCompletionBarrier.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCROLLING.JS - Navigation & Scroll Restoration Orchestrator
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module is the PRIMARY ORCHESTRATOR for scroll restoration and navigation
 * to internal IDs (highlights, hypercites, paragraphs). Despite being older than
 * lazyLoaderFactory.js, it remains essential for navigation functionality.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RELATIONSHIP WITH LAZYLOADERFACTORY.JS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These two modules work together with clear separation of concerns:
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ lazyLoaderFactory.js (WRITE SIDE - Saves scroll positions)             │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ • Continuously saves scroll position as user scrolls (throttled 250ms)  │
 * │ • Writes to sessionStorage/localStorage                                 │
 * │ • Manages scroll locking during navigation                              │
 * │ • Has instance method: restoreScrollPositionAfterResize()               │
 * │   (Quick restore after viewport resize - NOT the main entry point)      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ scrolling.js (READ SIDE - Restores positions & handles navigation)     │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ • Exports restoreScrollPosition() - MAIN entry point on page load       │
 * │ • Reads saved positions from storage                                    │
 * │ • Handles complex navigation scenarios (URL hashes, highlights, etc.)   │
 * │ • Provides navigateToInternalId() for programmatic navigation           │
 * │ • Tracks user scroll activity to prevent restoration interference       │
 * │ • Shows/hides navigation loading overlays                               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CORE RESPONSIBILITIES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. USER SCROLL STATE TRACKING (lines 22-126)
 *    - Detects when user is actively scrolling (mouse, touch, keyboard)
 *    - Prevents restoration from interfering with manual scrolling
 *    - Exports: isUserCurrentlyScrolling(), shouldSkipScrollRestoration()
 *
 * 2. SCROLL RESTORATION (lines 372-519)
 *    - restoreScrollPosition() - Main entry point called on page load
 *    - Handles URL hashes (#hypercite_xxx, #HL_xxx, #123)
 *    - Reads saved positions from storage
 *    - Delegates to navigateToInternalId() for actual navigation
 *
 * 3. NAVIGATION TO INTERNAL IDs (lines 660-1071)
 *    - navigateToInternalId() - Core navigation function
 *    - Handles highlights, hypercites, and paragraph IDs
 *    - Loads required chunks if not already loaded
 *    - Waits for DOM readiness before scrolling
 *    - Shows loading overlays during navigation
 *
 * 4. SCROLL UTILITIES (lines 129-208)
 *    - scrollElementIntoMainContent() - Consistent scroll behavior
 *    - scrollElementWithConsistentMethod() - Low-level scroll logic
 *    - Handles both window and container scrolling
 *    - Applies header offsets correctly
 *
 * 5. NAVIGATION LOADING OVERLAYS (lines 522-658)
 *    - showNavigationLoading() - Display loading indicator
 *    - hideNavigationLoading() - Hide with completion animation
 *    - Persists across page transitions via sessionStorage
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CALL HIERARCHY & ENTRY POINTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PAGE LOAD:
 *   viewManager.js:784
 *     → restoreScrollPosition() [line 372]
 *       → navigateToInternalId() [line 660]
 *         → _navigateToInternalId() [line 751]
 *           → scrollElementWithConsistentMethod() [line 129]
 *
 * PROGRAMMATIC NAVIGATION (e.g., clicking a highlight link):
 *   hyperLights.js or hypercites/index.js
 *     → navigateToInternalId() [line 660]
 *       → _navigateToInternalId() [line 751]
 *
 * VIEWPORT RESIZE:
 *   lazyLoaderFactory.js:527
 *     → instance.restoreScrollPositionAfterResize() [lazyLoaderFactory.js:307]
 *       (Quick restore - NOT the main restoration logic)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPORTED FUNCTIONS (Public API)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * • restoreScrollPosition() - Main restoration entry point (page load)
 * • navigateToInternalId() - Navigate to specific element ID
 * • scrollElementIntoMainContent() - Scroll utility for consistent behavior
 * • showNavigationLoading() - Display loading overlay
 * • hideNavigationLoading() - Hide loading overlay
 * • restoreNavigationOverlayIfNeeded() - Restore overlay after page transition
 * • shouldSkipScrollRestoration() - Check if restoration should be blocked
 * • isUserCurrentlyScrolling() - Check if user is actively scrolling
 * • isActivelyScrollingForLinkBlock() - Tighter check for link click blocking
 * • setupUserScrollDetection() - Initialize scroll tracking for container
 * • isValidContentElement() - Utility to check if element should be tracked
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN TO USE WHICH FUNCTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Use restoreScrollPosition():
 *   - On page load to restore saved position or navigate to URL hash
 *   - When switching between reader/edit views
 *
 * Use navigateToInternalId():
 *   - When user clicks a highlight or hypercite link
 *   - When programmatically navigating to a specific element
 *   - When handling cross-document citations
 *
 * Use scrollElementIntoMainContent():
 *   - When you just need to scroll to an element that's already in the DOM
 *   - For simple, direct scrolling without loading chunks
 *
 * Use instance.restoreScrollPositionAfterResize() (lazyLoaderFactory):
 *   - Automatically called on viewport resize
 *   - Quick restore without full navigation logic
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { book, OpenHyperlightID, OpenFootnoteID } from "./app.js";
import { openHighlightById } from './hyperlights/index.js';
import {
  getNodeChunksFromIndexedDB,
  getLocalStorageKey
} from "./indexedDB/index.js";
import { parseMarkdownIntoChunksInitial } from "./utilities/convertMarkdown.js";
import { currentLazyLoader, pendingFirstChunkLoadedPromise } from "./initializePage.js";
import { repositionSentinels } from "./lazyLoaderFactory.js"; // if exported
import {
  waitForNavigationTarget,
  waitForElementReady,
  waitForChunkLoadingComplete
} from "./domReadiness.js";
import { highlightTargetHypercite } from "./hypercites/index.js";
import { revealGhostIfTombstone } from "./hypercites/animations.js";
import { shouldSkipScrollRestoration as shouldSkipScrollRestorationGlobal, setSkipScrollRestoration } from "./utilities/operationState.js";
import { ProgressOverlayConductor } from './navigation/ProgressOverlayConductor.js';
import { isSearchToolbarOpen } from './search/inTextSearch/searchToolbar.js';

// ========= Scrolling Helper Functions =========

// Track hashes we've already navigated to during THIS page session.
// Module-level (not history.state) so it resets on page reload,
// allowing fresh page loads to always navigate to the URL hash.
const navigatedHashes = new Set();

/**
 * Clear navigated hashes (called on popstate so back/forward re-navigates)
 */
export function clearNavigatedHashes() {
  navigatedHashes.clear();
}

// Global scroll state management to prevent restoration interference
let userScrollState = {
  isScrolling: false,
  lastUserScrollTime: 0,
  scrollTimeout: null,
  isNavigating: false, // Flag to ignore navigation scrolls
  touchStartY: null, // Track touch start position
  touchStartX: null
};

// Store pending navigation cleanup timer so it can be cancelled
let pendingNavigationCleanupTimer = null;

// Persist the cascade-origin highlight ID so it survives chunk re-renders
let cascadeOriginTargetId = null;

/**
 * Get the current cascade-origin highlight ID (for re-applying after chunk loads)
 */
export function getCascadeOriginId() {
  return cascadeOriginTargetId;
}

/**
 * Set the cascade-origin highlight ID (for persisting across chunk re-renders)
 */
export function setCascadeOriginId(id) {
  cascadeOriginTargetId = id;
}

/**
 * Clear the cascade-origin state (called when container closes)
 */
export function clearCascadeOriginId() {
  cascadeOriginTargetId = null;
}

function detectUserScrollStart(event) {
  // Don't treat navigation scrolls as user scrolls
  if (userScrollState.isNavigating) {
    verbose.content(`NAVIGATION SCROLL - Ignoring as user scroll`, 'scrolling.js');
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

  userScrollState.isScrolling = true;
  userScrollState.lastUserScrollTime = Date.now();

  // Clear any existing timeout
  if (userScrollState.scrollTimeout) {
    clearTimeout(userScrollState.scrollTimeout);
  }

  verbose.content(`USER SCROLL DETECTED - Disabling all scroll restoration for 1 second`, 'scrolling.js');

  // Reset after 1 second of no scroll events (reduced from 2 seconds)
  userScrollState.scrollTimeout = setTimeout(() => {
    userScrollState.isScrolling = false;
    userScrollState.touchStartY = null;
    userScrollState.touchStartX = null;
    verbose.content(`USER SCROLL ENDED - Re-enabling scroll restoration`, 'scrolling.js');
  }, 1000);
}

export function isUserCurrentlyScrolling() {
  const timeSinceLastScroll = Date.now() - userScrollState.lastUserScrollTime;
  return userScrollState.isScrolling || timeSinceLastScroll < 2000;
}

// Separate check for blocking link clicks - MUCH tighter timing
// Allows: scroll → stop → immediately click
export function isActivelyScrollingForLinkBlock() {
  // Only block if we're in an active scroll RIGHT NOW
  // The isScrolling flag gets cleared after 1 second of no scroll events
  // Plus a tiny 200ms buffer to catch the tail end of momentum scrolling
  const timeSinceLastScroll = Date.now() - userScrollState.lastUserScrollTime;
  return userScrollState.isScrolling && timeSinceLastScroll < 200;
}

export function shouldSkipScrollRestoration(reason = "user scrolling") {
  const skip = isUserCurrentlyScrolling();
  if (skip) {
    verbose.nav(`SKIP RESTORATION: ${reason} - user was scrolling ${Date.now() - userScrollState.lastUserScrollTime}ms ago`, 'scrolling.js');
  }
  return skip;
}

/**
 * Cancel any pending navigation cleanup timer
 * Used by search toolbar to prevent navigation from interfering with keyboard positioning
 */
export function cancelPendingNavigationCleanup() {
  if (pendingNavigationCleanupTimer) {
    clearTimeout(pendingNavigationCleanupTimer);
    pendingNavigationCleanupTimer = null;
  }
}

/**
 * Mark scroll state as navigating to prevent scroll events from being detected as user scrolls.
 * Used by refresh() to prevent content reloading from triggering "user scroll" detection.
 */
export function setNavigatingState(isNavigating) {
  userScrollState.isNavigating = isNavigating;
}

// Clear all stale scroll tracking from the previous book
export function resetUserScrollState() {
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
export function setupUserScrollDetection(scrollableContainer) {
  if (!scrollableContainer) {
    console.warn("No scrollable container provided for user scroll detection");
    return;
  }

  verbose.init(`User scroll detection for: ${scrollableContainer.className || scrollableContainer.id}`, 'scrolling.js');
  
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
  }, { passive: true });
  
}

// Reusable scroll correction — recalculates offsetTop and snaps if the element drifted
function correctScrollPosition(targetElement, scrollableContainer, headerOffset) {
  let elementOffset = 0;
  let el = targetElement;
  while (el && el !== scrollableContainer) {
    elementOffset += el.offsetTop;
    el = el.offsetParent;
  }

  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = scrollableContainer.getBoundingClientRect();
  const currentElementPosition = elementRect.top - containerRect.top;

  if (Math.abs(currentElementPosition - headerOffset) > 20) {
    const targetScrollTop = Math.max(0, elementOffset - headerOffset);
    scrollableContainer.scrollTo({ top: targetScrollTop, behavior: "instant" });
  }
}

// Consistent scroll method to be used throughout the application
function scrollElementWithConsistentMethod(targetElement, scrollableContainer, headerOffset = 192) {
  if (!targetElement || !scrollableContainer) {
    console.error("Missing target element or scrollable container for consistent scroll");
    return;
  }

  // Skip if content doesn't overflow (nothing to scroll)
  if (scrollableContainer.scrollHeight <= scrollableContainer.clientHeight) {
    return;
  }

  // Mark as navigation scroll to prevent user scroll detection interference
  userScrollState.isNavigating = true;

  // Calculate element's position using offsetTop for stable positioning
  let elementOffset = 0;
  let el = targetElement;
  while (el && el !== scrollableContainer) {
    elementOffset += el.offsetTop;
    el = el.offsetParent;
  }

  const targetScrollTop = Math.max(0, elementOffset - headerOffset);

  // Apply scroll with instant behavior to avoid animation conflicts
  scrollableContainer.scrollTo({
    top: targetScrollTop,
    behavior: "instant"
  });

  // --- Image-aware scroll correction ---
  // Collect images inside the container that are above the target element and still loading
  const allImages = scrollableContainer.querySelectorAll("img");
  const pendingImages = [];
  for (const img of allImages) {
    // Only care about images that appear before the target in document order
    if (img.compareDocumentPosition(targetElement) & Node.DOCUMENT_POSITION_FOLLOWING) {
      if (!img.complete) {
        pendingImages.push(img);
      }
    }
  }

  // Always fire a 100ms correction for non-image layout shifts (fonts, etc.)
  setTimeout(() => {
    if (shouldSkipScrollRestoration("scroll correction")) return;
    userScrollState.isNavigating = true;
    correctScrollPosition(targetElement, scrollableContainer, headerOffset);
  }, 100);

  if (pendingImages.length === 0) {
    // No pending images — just clear navigation flag after the 100ms correction settles
    setTimeout(() => { userScrollState.isNavigating = false; }, 1000);
  } else {
    // Track how many images are still pending so we know when all are done
    let remaining = pendingImages.length;
    let releaseTimer = null;
    const cleanupFns = [];

    const onImageSettled = () => {
      remaining--;
      if (shouldSkipScrollRestoration("image load correction")) return;

      // Re-assert navigating so the correction scroll isn't treated as user scroll
      userScrollState.isNavigating = true;
      requestAnimationFrame(() => {
        correctScrollPosition(targetElement, scrollableContainer, headerOffset);
      });

      // Reset the release timer — wait 500ms after the last image event
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => { userScrollState.isNavigating = false; }, 500);
    };

    for (const img of pendingImages) {
      const onLoad = () => onImageSettled();
      const onError = () => onImageSettled();
      img.addEventListener("load", onLoad, { once: true });
      img.addEventListener("error", onError, { once: true });
      cleanupFns.push(() => {
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
      });
    }

    // Safety cleanup at 8 seconds — remove any remaining listeners to prevent leaks
    setTimeout(() => {
      cleanupFns.forEach(fn => fn());
      userScrollState.isNavigating = false;
    }, 8000);
  }

  return targetScrollTop;
}

export function scrollElementIntoMainContent(targetElement, headerOffset = 50) {
  // Find scrollable parent from the target element directly (handles lkj vs lkjPrivate etc)
  const scrollableParent = targetElement.closest(".reader-content-wrapper") ||
                           targetElement.closest(".home-content-wrapper") ||
                           targetElement.closest(".user-content-wrapper");

  if (!scrollableParent) {
    console.error("No scrollable parent wrapper found for target element");
    return;
  }

  // 🎯 USE CONSISTENT SCROLL METHOD
  scrollElementWithConsistentMethod(targetElement, scrollableParent, headerOffset);
}

function lockScrollToTarget(targetElement, headerOffset = 50, attempts = 3) {
  let count = 0;
  const interval = setInterval(() => {
    scrollElementIntoMainContent(targetElement, headerOffset);
    count++;
    if (count >= attempts) clearInterval(interval);
  }, 300);
}

export function isValidContentElement(el) {
  // Exclude sentinels & non-content elements:
  if (
    !el.id ||
    el.id.includes("sentinel") ||
    el.id.startsWith("toc-") ||
    el.id === "ref-overlay"
  ) {
    verbose.nav(`Skipping non-tracked element: ${el.id}`, 'scrolling.js');
    return false;
  }
  return ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "IMG"].includes(
    el.tagName
  );
}


// Adjusted helper: load default content if container is empty.
async function loadDefaultContent(lazyLoader) {
  verbose.nav("Loading default content (first chunk)...", 'scrolling.js');

  // Check if we already have nodes
  if (!lazyLoader.nodes || lazyLoader.nodes.length === 0) {
    verbose.nav("No nodes in memory, trying to fetch from IndexedDB...", 'scrolling.js');
    try {
      let cachedNodeChunks = await getNodeChunksFromIndexedDB(lazyLoader.bookId);
      if (cachedNodeChunks && cachedNodeChunks.length > 0) {
        verbose.nav(`Found ${cachedNodeChunks.length} chunks in IndexedDB`, 'scrolling.js');
        lazyLoader.nodes = cachedNodeChunks;
      } else {
        // Fallback: fetch markdown and parse
        verbose.nav("No cached chunks found. Fetching main-text.md...", 'scrolling.js');
        const response = await fetch(`/${lazyLoader.bookId}/main-text.md`);
        if (!response.ok) {
          throw new Error(`Failed to fetch markdown: ${response.status}`);
        }
        const markdown = await response.text();
        lazyLoader.nodes = parseMarkdownIntoChunksInitial(markdown);
        verbose.nav(`Parsed ${lazyLoader.nodes.length} chunks from markdown`, 'scrolling.js');
      }
    } catch (error) {
      console.error("Error loading content:", error);
      throw error; // Re-throw to handle in the calling function
    }
  }
  
  // Clear container and load first chunk
  // ⚠️ DIAGNOSTIC: Log when container is cleared
  const childCount = lazyLoader.container.children.length;
  if (childCount > 0) {
    console.warn(`⚠️ CONTAINER CLEAR (loadDefaultContent): ${childCount} children removed`, {
      stack: new Error().stack,
      timestamp: Date.now()
    });
  }
  lazyLoader.container.innerHTML = "";
  
  // Find chunks with chunk_id === 0
  const firstChunks = lazyLoader.nodes.filter(node => node.chunk_id === 0);
  if (firstChunks.length === 0) {
    console.warn("No chunks with ID 0 found! Loading first available chunk instead.");
    if (lazyLoader.nodes.length > 0) {
      lazyLoader.loadChunk(lazyLoader.nodes[0].chunk_id, "down");
    } else {
      throw new Error("No chunks available to load");
    }
  } else {
    verbose.nav(`Loading ${firstChunks.length} chunks with ID 0`, 'scrolling.js');
    firstChunks.forEach(node => {
      lazyLoader.loadChunk(node.chunk_id, "down");
    });
  }
  
  // Ensure sentinels are properly positioned
  if (typeof lazyLoader.repositionSentinels === "function") {
    lazyLoader.repositionSentinels();
  } else if (typeof repositionSentinels === "function") {
    repositionSentinels(lazyLoader);
  }
  
  // Verify content was loaded
  if (lazyLoader.container.children.length === 0) {
    console.error("Failed to load any content into container!");
    throw new Error("No content loaded");
  }
  
  verbose.nav("Default content loaded successfully", 'scrolling.js');
}


/**
 * Fallback function that tries to load a saved scroll position or scrolls to top
 */
async function fallbackScrollPosition(lazyLoader) {
  if (shouldSkipScrollRestoration("fallbackScrollPosition")) {
    return;
  }

  const chunkElements = Array.from(lazyLoader.container.children).filter(
    el => el.classList.contains("chunk")
  );
  
  // If no chunks, load default content
  if (chunkElements.length === 0) {
    try {
      await loadDefaultContent(lazyLoader);
    } catch (error) {
      console.error("Failed to load default content:", error);
      const errorDiv = document.createElement('div');
      errorDiv.className = "chunk";
      errorDiv.innerHTML = "<p>Unable to load content. Please refresh the page.</p>";
      
      const bottomSentinel = lazyLoader.container.querySelector(`#${lazyLoader.bookId}-bottom-sentinel`);
      if (bottomSentinel) {
        lazyLoader.container.insertBefore(errorDiv, bottomSentinel);
      } else {
        lazyLoader.container.appendChild(errorDiv);
      }
      return;
    }
  }

  // Try to find a saved scroll position
  const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
  let savedTargetId = null;
  
  // Check session storage first, then local storage
  try {
    const sessionData = sessionStorage.getItem(scrollKey);
    if (sessionData && sessionData !== "0") {
      const parsed = JSON.parse(sessionData);
      if (parsed?.elementId) savedTargetId = parsed.elementId;
    }
    
    if (!savedTargetId) {
      const localData = localStorage.getItem(scrollKey);
      if (localData && localData !== "0") {
        const parsed = JSON.parse(localData);
        if (parsed?.elementId) savedTargetId = parsed.elementId;
      }
    }
  } catch (e) {
    console.warn("Error reading saved scroll position", e);
  }

  // Scroll to saved target if it exists
  if (savedTargetId) {
    const targetElement = lazyLoader.container.querySelector(`#${CSS.escape(savedTargetId)}`);
    if (targetElement) {
      scrollElementIntoMainContent(targetElement, 50);
      return;
    }
  }

  // Fallback to top of page
  lazyLoader.container.scrollTo({ top: 0, behavior: "smooth" });
}



export async function restoreScrollPosition() {
  // Convert ?scroll= query param to hash (used by Word doc links to avoid # → %23 encoding)
  const scrollParam = new URLSearchParams(window.location.search).get('scroll');
  if (scrollParam) {
    const cleanUrl = window.location.origin + window.location.pathname;
    history.replaceState(history.state, '', cleanUrl + '#' + scrollParam);
  }

  // 🔍 DIAGNOSTIC: Entry point logging
  verbose.nav('restoreScrollPosition() ENTRY', 'scrolling.js');
  verbose.nav(`URL = ${window.location.href}`, 'scrolling.js');
  verbose.nav(`URL hash = ${window.location.hash}`, 'scrolling.js');

  // Skip if content doesn't overflow (nothing to scroll)
  const wrapper = document.querySelector('.home-content-wrapper') ||
                  document.querySelector('.user-content-wrapper') ||
                  document.querySelector('.reader-content-wrapper');

  // 🔍 DIAGNOSTIC: Log current scroll state BEFORE any logic
  if (wrapper) {
    verbose.nav(`Current scrollTop = ${wrapper.scrollTop}`, 'scrolling.js');
    verbose.nav(`scrollHeight = ${wrapper.scrollHeight}, clientHeight = ${wrapper.clientHeight}`, 'scrolling.js');
    const existingChunks = wrapper.querySelectorAll('[data-chunk-id]');
    verbose.nav(`Existing chunks in DOM = ${existingChunks.length}`, 'scrolling.js');
    if (existingChunks.length > 0) {
      const chunkIds = Array.from(existingChunks).map(c => c.getAttribute('data-chunk-id'));
      verbose.nav(`Chunk IDs = ${chunkIds.join(', ')}`, 'scrolling.js');
    }
  }

  // Only bail early if actual content is loaded but doesn't overflow.
  // When no chunks are in the DOM yet we still need to proceed to load them.
  const hasChunksInDom = wrapper && wrapper.querySelectorAll('[data-chunk-id]').length > 0;
  if (hasChunksInDom && wrapper.scrollHeight <= wrapper.clientHeight && !window.location.hash) {
    verbose.nav('EARLY EXIT - content doesnt overflow and no hash target', 'scrolling.js');
    return;
  }

  // Check if user is currently scrolling
  if (shouldSkipScrollRestoration("restoreScrollPosition")) {
    return;
  }

  // Skip if search toolbar is blocking navigation
  if (window.searchToolbarBlockingNavigation) {
    verbose.nav('RESTORE SCROLL: Search toolbar blocking navigation, skipping restoration', 'scrolling.js');
    return;
  }

  // Skip if search toolbar is open - don't interfere with search UX
  if (isSearchToolbarOpen()) {
    verbose.nav('RESTORE SCROLL: Search toolbar is open, skipping restoration', 'scrolling.js');
    return;
  }

  if (!currentLazyLoader) {
    console.error("Lazy loader instance not available!");
    return;
  }

  // 🚀 FIX: Skip if we're already navigating to a target
  // This prevents race conditions with BookToBookTransition and other navigation pathways
  if (currentLazyLoader.isNavigatingToInternalId) {
    return;
  }

  // 🚀 FIX: Check global flag to skip scroll restoration (set by BookToBookTransition for hash navigation)
  if (shouldSkipScrollRestorationGlobal()) {
    verbose.nav('RESTORE SCROLL: Skip flag is set, clearing and returning', 'scrolling.js');
    setSkipScrollRestoration(false); // Clear the flag for next time
    return;
  }

  // 🚀 FIX: Check if we're on a hyperlight URL path (like /book/HL_xxxxx)
  // If so, skip scroll restoration - BookToBookTransition will handle navigation
  const pathSegments = window.location.pathname.split('/').filter(Boolean);
  const isHyperlightPath = pathSegments.length >= 2 && pathSegments[1]?.startsWith('HL_');
  const isFootnotePath = pathSegments.length >= 2 && (pathSegments[1]?.includes('_Fn') || pathSegments[1]?.startsWith('Fn'));
  if (isHyperlightPath) {
    verbose.nav(`RESTORE SCROLL: Hyperlight path detected (${pathSegments[1]}), skipping`, 'scrolling.js');
    return;
  }
  if (isFootnotePath) {
    verbose.nav(`RESTORE SCROLL: Footnote path detected (${pathSegments[1]}), skipping`, 'scrolling.js');
    return;
  }

  // If we're navigating to an internal ID (like a highlight or footnote), prioritize that
  const targetInternalId = OpenHyperlightID || OpenFootnoteID;
  if (currentLazyLoader.isNavigatingToInternalId && targetInternalId) {
    verbose.nav(`Prioritizing navigation to internal ID: ${targetInternalId}`, 'scrolling.js');
    navigateToInternalId(targetInternalId, currentLazyLoader, false);
    return; // Exit early, don't proceed with normal scroll restoration
  }

  // Read target id from URL hash first.
  let targetId = window.location.hash.substring(1);

  // Check if we've already navigated to this hash during THIS page session.
  // Uses module-level Set (not history.state) so it resets on page reload,
  // ensuring fresh page loads always navigate to the URL hash target.
  const alreadyNavigatedToHash = navigatedHashes.has(targetId);
  const hasExplicitTarget = !!targetId && !alreadyNavigatedToHash;

  verbose.nav(`RESTORE SCROLL: URL hash: "${targetId}", alreadyNavigated: ${alreadyNavigatedToHash}, explicit: ${hasExplicitTarget}`, 'scrolling.js');
  
  // Show overlay for external navigation targets
  let overlayShown = false;
  const existingOverlay = document.getElementById('initial-navigation-overlay');
  const overlayAlreadyVisible = existingOverlay && (
    existingOverlay.style.display !== 'none' &&
    existingOverlay.style.display !== ''
  );
  
  const isInternalNavigation = hasExplicitTarget && (
    targetId.startsWith('hypercite_') || 
    targetId.startsWith('HL_') || 
    /^\d+$/.test(targetId)
  );
  
  if (hasExplicitTarget && !overlayAlreadyVisible && !isInternalNavigation) {
    showNavigationLoading(targetId);
    overlayShown = true;
  } else if (overlayAlreadyVisible) {
    overlayShown = true;
  }

  // Only use saved scroll position if there's no explicit target in URL
  // AND we're not currently navigating to an internal ID
  if (!hasExplicitTarget && !currentLazyLoader.isNavigatingToInternalId) {
    verbose.nav('RESTORE SCROLL: No explicit target, checking saved positions...', 'scrolling.js');
    try {
      const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
      verbose.nav(`Storage key = ${scrollKey}`, 'scrolling.js');

      // Try session storage first
      const sessionData = sessionStorage.getItem(scrollKey);
      verbose.nav(`Raw sessionStorage data = ${sessionData}`, 'scrolling.js');
      if (sessionData && sessionData !== "0") {
        const parsed = JSON.parse(sessionData);
        verbose.nav(`Parsed session data = ${JSON.stringify(parsed)}`, 'scrolling.js');
        if (parsed?.elementId) {
          targetId = parsed.elementId;
          verbose.nav(`Using saved session position: ${targetId}`, 'scrolling.js');
        }
      }

      // Fallback to localStorage
      if (!targetId) {
        const localData = localStorage.getItem(scrollKey);
        verbose.nav(`Raw localStorage data = ${localData}`, 'scrolling.js');
        if (localData && localData !== "0") {
          const parsed = JSON.parse(localData);
          verbose.nav(`Parsed local data = ${JSON.stringify(parsed)}`, 'scrolling.js');
          if (parsed?.elementId) {
            targetId = parsed.elementId;
            verbose.nav(`Using saved local position: ${targetId}`, 'scrolling.js');
          }
        }
      }
    } catch (e) {
      console.warn("Error reading saved scroll position", e);
    }
  } else if (currentLazyLoader.isNavigatingToInternalId) {
    verbose.nav('RESTORE SCROLL: Internal navigation in progress, IGNORING saved scroll positions', 'scrolling.js');
  } else {
    verbose.nav('RESTORE SCROLL: Explicit target found, IGNORING any saved scroll positions', 'scrolling.js');
  }

  verbose.nav(`Final targetId after storage check = ${targetId || '(empty)'}`, 'scrolling.js');

  if (!targetId) {
    // 🔍 DIAGNOSTIC: This is the problematic path
    verbose.nav('NO targetId - entering chunk 0 loading path', 'scrolling.js');
    verbose.nav('WHY? Check if storage data was null/empty above', 'scrolling.js');

    // Load first chunk when no saved position
    try {
      let cachedNodeChunks = await getNodeChunksFromIndexedDB(currentLazyLoader.bookId);
      verbose.nav(`Got cachedNodeChunks from IndexedDB, count = ${cachedNodeChunks?.length || 0}`, 'scrolling.js');

      if (cachedNodeChunks?.length > 0) {
        // 🛡️ FIX: Check if content already exists in DOM (e.g., from bfcache)
        // If so, preserve it and let browser's scroll restoration work
        const existingChunks = currentLazyLoader.container.querySelectorAll('[data-chunk-id]');
        verbose.nav(`Existing chunks in DOM = ${existingChunks.length}`, 'scrolling.js');

        if (existingChunks.length > 0) {
          verbose.nav('Content exists in DOM - preserving instead of clearing', 'scrolling.js');
          verbose.nav(`Current scrollTop = ${currentLazyLoader.scrollableParent?.scrollTop}`, 'scrolling.js');

          // Sync lazy loader state with existing DOM
          existingChunks.forEach(chunk => {
            const chunkId = parseFloat(chunk.getAttribute('data-chunk-id'));
            currentLazyLoader.currentlyLoadedChunks.add(chunkId);
          });
          currentLazyLoader.nodes = cachedNodeChunks;

          // Save current scroll position for future restores
          if (currentLazyLoader.saveScrollPosition) {
            setTimeout(() => currentLazyLoader.saveScrollPosition(), 100);
          }

          return; // Exit - browser's restored position will be preserved
        }

        // No existing content - safe to clear and load chunk 0
        verbose.nav('No existing content, loading chunk 0', 'scrolling.js');
        currentLazyLoader.nodes = cachedNodeChunks;
        // ⚠️ DIAGNOSTIC: Log when container is cleared
        const childCount2 = currentLazyLoader.container.children.length;
        if (childCount2 > 0) {
          console.warn(`⚠️ CONTAINER CLEAR (scroll restore): ${childCount2} children removed`, {
            stack: new Error().stack,
            timestamp: Date.now()
          });
        }
        currentLazyLoader.container.innerHTML = "";
        // Load chunk 0 if available, otherwise load the lowest available chunk
        const chunk0Nodes = currentLazyLoader.nodes.filter(node => node.chunk_id === 0);
        let loadedChunkId;
        if (chunk0Nodes.length > 0) {
          loadedChunkId = 0;
          await currentLazyLoader.loadChunk(0, "down");
        } else if (currentLazyLoader.nodes.length > 0) {
          // Chunked lazy loading: initial chunk may not be chunk 0
          loadedChunkId = currentLazyLoader.nodes
            .reduce((min, n) => Math.min(min, n.chunk_id), Infinity);
          await currentLazyLoader.loadChunk(loadedChunkId, "down");
        }

        // If the loaded chunk has fewer than 20 nodes, load the next chunk too
        if (loadedChunkId !== undefined) {
          const loadedNodeCount = currentLazyLoader.container.querySelectorAll('[data-node-id]').length;
          if (loadedNodeCount < 20) {
            const allChunkIds = currentLazyLoader.chunkManifest
              ? currentLazyLoader.chunkManifest.map(m => m.chunk_id)
              : [...new Set(currentLazyLoader.nodes.map(n => n.chunk_id))].sort((a, b) => a - b);
            const pos = allChunkIds.indexOf(loadedChunkId);
            let nextPos = pos + 1;
            while (nextPos < allChunkIds.length && currentLazyLoader.container.querySelectorAll('[data-node-id]').length < 20) {
              const nextId = allChunkIds[nextPos];
              const hasNodes = currentLazyLoader.nodes.some(n => n.chunk_id === nextId);
              if (!hasNodes) break;
              await currentLazyLoader.loadChunk(nextId, "down");
              nextPos++;
            }
          }
        }
        return;
      }
      
      // Fallback to markdown fetch
      const response = await fetch(`/${book}/main-text.md`);
      const markdown = await response.text();
      currentLazyLoader.nodes = parseMarkdownIntoChunksInitial(markdown);
      currentLazyLoader.nodes
        .filter(node => node.chunk_id === 0)
        .forEach(node => currentLazyLoader.loadChunk(node.chunk_id, "down"));
    } catch (error) {
      console.error("Error loading content:", error);
      currentLazyLoader.container.innerHTML = "<p>Unable to load content. Please refresh the page.</p>";
    }
    return;
  }

  // Navigate to the target position
  navigateToInternalId(targetId, currentLazyLoader, !overlayShown);
}

// ═════════════════════════════════════════════════════════════════════
// NAVIGATION LOADING - DELEGATED TO PROGRESSOVERLAYCONDUCTOR
// ═════════════════════════════════════════════════════════════════════
// These functions delegate to ProgressOverlayConductor for centralized overlay management
// LEGACY: These were originally managing overlays directly, now they're thin wrappers

export function showNavigationLoading(targetId) {
  verbose.nav(`[LEGACY] showNavigationLoading called for ${targetId} - delegating to ProgressOverlayConductor`, 'scrolling.js');

  // Delegate to the new centralized system (now statically imported)
  ProgressOverlayConductor.showSPATransition(5, `Loading ${targetId}...`);

  return {
    updateProgress: (percent, message) => {
      ProgressOverlayConductor.updateProgress(percent, message);
    },
    setMessage: (message) => {
      ProgressOverlayConductor.updateProgress(null, message);
    }
  };
}

export async function hideNavigationLoading() {
  verbose.content(`[LEGACY] hideNavigationLoading called - delegating to ProgressOverlayConductor`, 'scrolling.js');

  // Delegate to the new centralized system (now statically imported)
  await ProgressOverlayConductor.hide();
}

// ═════════════════════════════════════════════════════════════════════
// RESTORE NAVIGATION OVERLAY - DEPRECATED
// ═════════════════════════════════════════════════════════════════════
// LEGACY: This function is now a no-op
// The ProgressOverlayEnactor handles its own state restoration via _bindElements()
// which detects overlay visibility using getComputedStyle on initialization

export function restoreNavigationOverlayIfNeeded() {
  verbose.nav('[LEGACY] restoreNavigationOverlayIfNeeded called - now handled by ProgressOverlayEnactor._bindElements()', 'scrolling.js');

  // Clear any legacy session storage flags (no longer used)
  sessionStorage.removeItem('navigationOverlayActive');
  sessionStorage.removeItem('navigationTargetId');

  return false; // Always return false - restoration handled by Enactor
}

export function navigateToInternalId(targetId, lazyLoader, showOverlay = true) {
  if (!lazyLoader) {
    console.error("Lazy loader instance not provided!");
    return Promise.reject(new Error("Lazy loader instance not provided"));
  }
  verbose.nav(`Initiating navigation to internal ID: ${targetId}`, 'scrolling.js');

  // 🚀 Return a Promise that resolves when navigation is truly complete
  // This fixes iOS Safari race condition where scroll restoration interferes
  return new Promise((resolve, reject) => {
    // Store resolve/reject on lazyLoader so _navigateToInternalId can call them
    lazyLoader._navigationResolve = resolve;
    lazyLoader._navigationReject = reject;

    // 🚀 CRITICAL: Set flag IMMEDIATELY to prevent race conditions
    // This prevents restoreScrollPosition() from interfering
    lazyLoader.isNavigatingToInternalId = true;
    lazyLoader.pendingNavigationTarget = targetId; // Store target for refresh() to use
    verbose.nav(`Set isNavigatingToInternalId = true for ${targetId}`, 'scrolling.js');

    // 🚦 Start the NavigationCompletionBarrier to coordinate async processes
    // This ensures flags persist until scroll completes. If a timestamp check triggers
    // a refresh, the captured navigation target is passed directly to refresh().
    NavigationCompletionBarrier.startNavigation(targetId, lazyLoader);
    NavigationCompletionBarrier.registerProcess(NavigationProcess.SCROLL_COMPLETE);

    // 🎯 Show loading indicator with progress tracking (only if requested)
    const progressIndicator = showOverlay ? showNavigationLoading(targetId) : { updateProgress: () => {}, setMessage: () => {} };

    // 🔒 NEW: Lock scroll position during navigation
    if (lazyLoader.lockScroll) {
      lazyLoader.lockScroll(`navigation to ${targetId}`);

      // 🔄 NEW: Detect user scroll and unlock immediately
      let userScrollDetected = false;
      const detectUserScroll = (event) => {
        if (!userScrollDetected && lazyLoader.scrollLocked) {
          verbose.nav('User scroll detected during navigation, unlocking immediately', 'scrolling.js');
          userScrollDetected = true;
          lazyLoader.unlockScroll();

          // 🚦 Abort the navigation barrier - user is taking control
          NavigationCompletionBarrier.abort();

          // Remove the listener once we've detected user scroll
          lazyLoader.scrollableParent.removeEventListener('wheel', detectUserScroll);
          lazyLoader.scrollableParent.removeEventListener('touchstart', detectUserScroll);
          lazyLoader.scrollableParent.removeEventListener('keydown', detectUserScroll);
        }
      };

      // Listen for user scroll inputs (mouse wheel, touch, keyboard)
      lazyLoader.scrollableParent.addEventListener('wheel', detectUserScroll, { passive: true });
      lazyLoader.scrollableParent.addEventListener('touchstart', detectUserScroll, { passive: true });
      lazyLoader.scrollableParent.addEventListener('keydown', detectUserScroll, { passive: true });

      // Clean up listeners after navigation timeout
      setTimeout(() => {
        lazyLoader.scrollableParent.removeEventListener('wheel', detectUserScroll);
        lazyLoader.scrollableParent.removeEventListener('touchstart', detectUserScroll);
        lazyLoader.scrollableParent.removeEventListener('keydown', detectUserScroll);
      }, 2000);
    }

    // 🚀 FIX: Clear session storage when explicitly navigating to prevent cached position interference
    if (targetId && targetId.trim() !== '') {
      const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
      verbose.nav(`Clearing session scroll cache for explicit navigation to: ${targetId}`, 'scrolling.js');
      sessionStorage.removeItem(scrollKey);
    }

    _navigateToInternalId(targetId, lazyLoader, progressIndicator);
  });
}

// Define helper function OUTSIDE the main function
function calculateScrollDelay(element, container, targetId) {
  let delay = 100; // Default short delay
  
  if (element) {
    // Check if element is in viewport
    const rect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    
    const isVisible = (
      rect.top >= containerRect.top &&
      rect.bottom <= containerRect.bottom &&
      rect.left >= containerRect.left &&
      rect.right <= containerRect.right
    );
    
    if (!isVisible) {
      // Element exists but not visible - needs scrolling
      delay = 400;
      verbose.nav(`Element ${targetId} needs scrolling, using ${delay}ms delay`, 'scrolling.js');
    } else {
      // Element is already visible - minimal delay
      delay = 100;
      verbose.nav(`Element ${targetId} already visible, using ${delay}ms delay`, 'scrolling.js');
    }
  } else {
    // Element doesn't exist yet - will need loading and scrolling
    delay = 800;
    verbose.nav(`Element ${targetId} not loaded yet, using ${delay}ms delay`, 'scrolling.js');
  }
  
  return delay;
}

async function _navigateToInternalId(targetId, lazyLoader, progressIndicator = null) {
  // Check if the target element is already present and fully rendered
  let existingElement = lazyLoader.container.querySelector(
    `#${CSS.escape(targetId)}`
  );
  
  // For hypercites, also check if it's part of an overlapping segment
  if (!existingElement && targetId.startsWith('hypercite_')) {
    const overlappingElements = lazyLoader.container.querySelectorAll('u[data-overlapping]');
    for (const element of overlappingElements) {
      const overlappingIds = element.getAttribute('data-overlapping');
      if (overlappingIds && overlappingIds.split(',').map(id => id.trim()).includes(targetId)) {
        verbose.nav(`Found hypercite ${targetId} in overlapping element`, 'scrolling.js');
        existingElement = element;
        break;
      }
    }
  }
  
  // Update progress - DOM check
  if (progressIndicator) {
    progressIndicator.updateProgress(20, "Checking if element is in DOM...");
  }
  
  let targetElement = existingElement;
  let elementsReady = false;
  
  if (existingElement) {
    try {
      // 🚀 Verify the element is actually ready before proceeding  
      verbose.nav(`Found existing element ${targetId}, verifying readiness...`, 'scrolling.js');
      
      if (progressIndicator) {
        progressIndicator.updateProgress(40, "Verifying element readiness...");
      }
      
      targetElement = await waitForElementReady(targetId, {
        maxAttempts: 5, // Quick check since element exists
        checkInterval: 20,
        container: lazyLoader.container
      });
      
      verbose.nav(`Existing element ${targetId} confirmed ready`, 'scrolling.js');
      elementsReady = true;
      
    } catch (error) {
      console.warn(`⚠️ Existing element ${targetId} not fully ready: ${error.message}. Proceeding with chunk loading...`);
      // Continue to chunk loading logic below
      targetElement = null;
    }
  }

  // If element not ready, determine which chunk should contain the target
  if (!elementsReady) {
    if (progressIndicator) {
      progressIndicator.updateProgress(30, "Looking up target in content chunks...");
    }
    
    // Unified resolver: queries IndexedDB stores (hypercites, hyperlights,
    // footnotes, nodes) to find which chunk contains the target.
    const { resolveTargetChunkId } = await import('./navigation/resolveTargetChunk.js');
    let resolution = await resolveTargetChunkId(lazyLoader.bookId, targetId, {
      chunkManifest: lazyLoader.chunkManifest,
      nodes: lazyLoader.nodes,
    });

    verbose.nav(
      `Resolver result for "${targetId}": chunk=${resolution.chunkId}, resolved=${resolution.resolved}, reason=${resolution.reason}`,
      'scrolling.js'
    );

    // If the resolver couldn't find the target and the book isn't fully loaded,
    // wait for the background download to complete and retry with the full dataset.
    if (!resolution.resolved && !lazyLoader.isFullyLoaded) {
      verbose.nav(`Target "${targetId}" not found in partial data — waiting for background download...`, 'scrolling.js');
      if (progressIndicator) {
        progressIndicator.updateProgress(40, "Loading remaining book data...");
      }

      const { waitForBackgroundDownload } = await import('./backgroundDownloader.js');
      await waitForBackgroundDownload();

      // Refresh nodes from IndexedDB now that all chunks are downloaded
      const freshNodes = await getNodeChunksFromIndexedDB(lazyLoader.bookId);
      if (freshNodes && freshNodes.length > 0) {
        lazyLoader.nodes = freshNodes;
        lazyLoader.chunkManifest = null;
        window.nodes = freshNodes;
      }

      // Retry the resolver with the complete dataset
      resolution = await resolveTargetChunkId(lazyLoader.bookId, targetId, {
        chunkManifest: lazyLoader.chunkManifest,
        nodes: lazyLoader.nodes,
      });

      verbose.nav(
        `Retry resolver result for "${targetId}": chunk=${resolution.chunkId}, resolved=${resolution.resolved}, reason=${resolution.reason}`,
        'scrolling.js'
      );
    }

    // If the primary target couldn't be resolved, show fallback UI
    if (!resolution.resolved) {
      console.warn(
        `No block found for target ID "${targetId}" (reason: ${resolution.reason}). ` +
          `Fallback: loading chunk ${resolution.chunkId}.`
      );

      // If we have no valid fallback chunk either, do the old fallback
      if (resolution.reason === 'lowest_chunk' && resolution.chunkId === 0 && !lazyLoader.nodes.some(n => n.chunk_id === 0)) {
        hideNavigationLoading();
        fallbackScrollPosition(lazyLoader);
        if (typeof lazyLoader.attachMarkListeners === "function") {
          lazyLoader.attachMarkListeners(lazyLoader.container);
        }
        lazyLoader.isNavigatingToInternalId = false;
        lazyLoader.pendingNavigationTarget = null;
        if (lazyLoader._navigationResolve) {
          lazyLoader._navigationResolve({ success: false, targetId, fallback: true });
          lazyLoader._navigationResolve = null;
          lazyLoader._navigationReject = null;
        }
        // Show contextual toast
        import('./utilities/toast.js').then(({ showTargetNotFoundToast }) => {
          showTargetNotFoundToast({ target: targetId, fallbackUsed: resolution.fallbackUsed });
        });
        return;
      }

      // Show contextual toast after scroll completes (deferred to avoid layout shift)
      setTimeout(() => {
        import('./utilities/toast.js').then(({ showTargetNotFoundToast }) => {
          showTargetNotFoundToast({ target: targetId, fallbackUsed: resolution.fallbackUsed });
        });
      }, 500);
    }

    // Map resolved chunk_id to an index in lazyLoader.nodes
    const targetChunkId = resolution.chunkId;
    let targetChunkIndex = lazyLoader.nodes.findIndex(n => n.chunk_id === targetChunkId);

    // If chunk not in lazyLoader.nodes (partial load), try to load it
    if (targetChunkIndex === -1) {
      // Refresh lazyLoader nodes from IndexedDB in case they were updated
      const freshNodes = await getNodeChunksFromIndexedDB(lazyLoader.bookId);
      if (freshNodes && freshNodes.length > 0) {
        lazyLoader.nodes = freshNodes;
        lazyLoader.chunkManifest = null;
        window.nodes = freshNodes;
        targetChunkIndex = freshNodes.findIndex(n => n.chunk_id === targetChunkId);
      }
    }

    if (targetChunkIndex === -1) {
      console.warn(`Resolved chunk ${targetChunkId} not found in lazyLoader nodes. Falling back.`);
      hideNavigationLoading();
      fallbackScrollPosition(lazyLoader);
      if (typeof lazyLoader.attachMarkListeners === "function") {
        lazyLoader.attachMarkListeners(lazyLoader.container);
      }
      lazyLoader.isNavigatingToInternalId = false;
      lazyLoader.pendingNavigationTarget = null;
      if (lazyLoader._navigationResolve) {
        lazyLoader._navigationResolve({ success: false, targetId, fallback: true });
        lazyLoader._navigationResolve = null;
        lazyLoader._navigationReject = null;
      }
      return;
    }

    // Clear the container and load the chunk (plus adjacent chunks).
    if (progressIndicator) {
      progressIndicator.updateProgress(50, "Clearing container and preparing to load chunks...");
    }

    // ⚠️ DIAGNOSTIC: Log when container is cleared during navigation
    const childCount3 = lazyLoader.container.children.length;
    if (childCount3 > 0) {
      console.warn(`⚠️ CONTAINER CLEAR (navigation): ${childCount3} children removed`, {
        stack: new Error().stack,
        targetId,
        timestamp: Date.now()
      });
    }
    lazyLoader.container.innerHTML = "";
    lazyLoader.currentlyLoadedChunks.clear();
    
    // targetChunkId already set from resolver — verify against node
    const targetNode = lazyLoader.nodes[targetChunkIndex];
    
    // Get all unique chunk_ids — use manifest when available (partial load)
    const allChunkIds = lazyLoader.chunkManifest
      ? lazyLoader.chunkManifest.map(m => m.chunk_id)
      : [...new Set(lazyLoader.nodes.map(n => n.chunk_id))].sort((a, b) => a - b);
    const targetChunkPosition = allChunkIds.indexOf(targetChunkId);
    
    // Load target chunk plus adjacent chunks
    const startChunkIndex = Math.max(0, targetChunkPosition - 1);
    const endChunkIndex = Math.min(allChunkIds.length - 1, targetChunkPosition + 1);
    const chunksToLoad = allChunkIds.slice(startChunkIndex, endChunkIndex + 1);
    
    verbose.nav(`Target element "${targetId}" is in chunk_id: ${targetChunkId}`, 'scrolling.js');
    verbose.nav(`Loading chunks: ${chunksToLoad.join(', ')} (target chunk position: ${targetChunkPosition})`, 'scrolling.js');

    if (progressIndicator) {
      progressIndicator.updateProgress(60, `Loading ${chunksToLoad.length} chunks...`);
    }

    // ✅ Just load synchronously, since loadChunk returns immediately
    const loadedChunks = chunksToLoad.map(chunkId => lazyLoader.loadChunk(chunkId, "down"));

    lazyLoader.repositionSentinels();
    
    if (progressIndicator) {
      progressIndicator.updateProgress(70, "Waiting for content to be ready...");
    }
    
    try {
      // 🚀 Use DOM readiness detection instead of fixed timeout
      verbose.nav(`Waiting for navigation target to be ready: ${targetId}`, 'scrolling.js');
      
      targetElement = await waitForNavigationTarget(
        targetId, 
        lazyLoader.container,
        targetChunkId, // Now we know the exact chunk ID!
        { 
          maxWaitTime: 5000, // 5 second max wait
          requireVisible: false 
        }
      );
      
      verbose.nav(`Navigation target ready: ${targetId}`, 'scrolling.js');
      elementsReady = true;
        
    } catch (error) {
      console.warn(`❌ Failed to wait for target element ${targetId}: ${error.message}. Trying fallback...`);
      
      // Fallback: try once more with querySelector in case it's there but not detected
      let fallbackTarget = lazyLoader.container.querySelector(`#${CSS.escape(targetId)}`);

      // For highlights, check by class (overlapping highlights use id="HL_overlap")
      if (!fallbackTarget && targetId.startsWith('HL_')) {
        fallbackTarget = lazyLoader.container.querySelector(`mark.${CSS.escape(targetId)}`);
      }

      // For hypercites, also check overlapping elements in fallback
      if (!fallbackTarget && targetId.startsWith('hypercite_')) {
        const overlappingElements = lazyLoader.container.querySelectorAll('u[data-overlapping]');
        for (const element of overlappingElements) {
          const overlappingIds = element.getAttribute('data-overlapping');
          if (overlappingIds && overlappingIds.split(',').map(id => id.trim()).includes(targetId)) {
            verbose.nav(`Found hypercite ${targetId} in overlapping element (fallback)`, 'scrolling.js');
            fallbackTarget = element;
            break;
          }
        }
      }
      
      if (fallbackTarget) {
        verbose.nav(`Found target on fallback attempt: ${targetId}`, 'scrolling.js');
        targetElement = fallbackTarget;
        elementsReady = true;
      } else {
        console.warn(`❌ Could not locate target element: ${targetId}`);
        hideNavigationLoading();
        // Complete the barrier so it doesn't leak for 10 seconds
        NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_COMPLETE, false);
        fallbackScrollPosition(lazyLoader);
        lazyLoader.isNavigatingToInternalId = false;
        lazyLoader.pendingNavigationTarget = null;
        if (lazyLoader.unlockScroll) {
          lazyLoader.unlockScroll();
        }
        // Resolve with fallback flag so callers know we didn't reach target
        if (lazyLoader._navigationResolve) {
          lazyLoader._navigationResolve({ success: false, targetId, fallback: true });
          lazyLoader._navigationResolve = null;
          lazyLoader._navigationReject = null;
        }
        return;
      }
    }
  }

  // ========= UNIFIED FINAL SCROLL SECTION =========
  // At this point, we have a confirmed ready targetElement
  if (elementsReady && targetElement) {
    if (progressIndicator) {
      progressIndicator.updateProgress(80, "Waiting for layout to stabilize...");
    }
    
    // 🚀 LAYOUT FIX: Wait for layout to complete before scrolling
    verbose.nav(`Waiting for layout completion before scrolling to: ${targetId}`, 'scrolling.js');
    
    try {
      await pendingFirstChunkLoadedPromise;
      verbose.nav('Layout complete, proceeding with scroll', 'scrolling.js');
    } catch (error) {
      console.warn(`⚠️ Layout promise failed, proceeding anyway: ${error.message}`);
    }
    
    if (progressIndicator) {
      progressIndicator.updateProgress(90, "Scrolling to target...");
    }
    
    // 🎯 FINAL SCROLL - Check if element is already visible before scrolling
    verbose.nav(`FINAL SCROLL: Navigating to confirmed ready element: ${targetId}`, 'scrolling.js');
    const scrollableParent = lazyLoader.scrollableParent;
    
    // Check if element is actually visible in the viewport
    const elementRect = targetElement.getBoundingClientRect();
    const containerRect = scrollableParent.getBoundingClientRect();
    const currentPosition = elementRect.top - containerRect.top;
    
    // Check visibility in the actual viewport (not just container bounds)
    const isInViewport = elementRect.top >= 0 && 
                        elementRect.bottom <= window.innerHeight &&
                        elementRect.left >= 0 && 
                        elementRect.right <= window.innerWidth;
    
    // Also check if it's within the container bounds
    const isInContainer = elementRect.top >= containerRect.top && 
                         elementRect.bottom <= containerRect.bottom;
    
    // Element is truly visible if it's both in viewport AND container
    const isAlreadyVisible = isInViewport && isInContainer;
    const isReasonablyPositioned = currentPosition >= 0 && currentPosition <= 300; // Within first 300px of container
    
    verbose.nav(`Element visibility: inViewport=${isInViewport}, inContainer=${isInContainer}, visible=${isAlreadyVisible}, position=${currentPosition}px`, 'scrolling.js');
    
    // Only scroll if element is not visible or poorly positioned
    if (!isAlreadyVisible || !isReasonablyPositioned) {
      if (scrollableParent && scrollableParent !== window) {
        verbose.nav(`Using consistent scroll for container: ${scrollableParent.className}`, 'scrolling.js');
        scrollElementWithConsistentMethod(targetElement, scrollableParent, 192);
      } else {
        verbose.nav('Using scrollIntoView for window scrolling', 'scrolling.js');
        targetElement.scrollIntoView({ 
          behavior: "smooth", 
          block: "start", 
          inline: "nearest" 
        });
      }
    } else {
      verbose.nav('Element already visible and well-positioned - skipping scroll', 'scrolling.js');
    }
    
    // For highlights, open the container (cascade-origin is applied there)
    if (targetId.startsWith('HL_')) {
      setTimeout(() => {
        verbose.nav(`Opening highlight after navigation: ${targetId}`, 'scrolling.js');
        openHighlightById(targetId);
      }, 200);
    }

    // For footnotes, play arrow-pulse animation for navigation emphasis
    if (targetId.includes('_Fn') || targetId.startsWith('Fn')) {
      const fnEl = document.getElementById(targetId);
      if (fnEl) {
        fnEl.classList.add('arrow-target');
        const handleEnd = (e) => {
          if (e.target === fnEl) {
            fnEl.classList.remove('arrow-target');
            fnEl.removeEventListener('animationend', handleEnd);
          }
        };
        fnEl.addEventListener('animationend', handleEnd);
      }
      setTimeout(async () => {
        verbose.nav(`Opening footnote after navigation: ${targetId}`, 'scrolling.js');
        const { handleUnifiedContentClick } = await import('./hyperlitContainer/index.js');
        const footnoteElement = document.getElementById(targetId);
        if (footnoteElement) {
          handleUnifiedContentClick(footnoteElement);
        }
      }, 200);
    }

    // Clean up navigation state
    if (typeof lazyLoader.attachMarkListeners === "function") {
      lazyLoader.attachMarkListeners(lazyLoader.container);
    }
    
    if (progressIndicator) {
      progressIndicator.updateProgress(100, "Navigation complete!");
    }
    
    // 🚨 SMART CLEANUP: Check if element is perfectly positioned to decide on delay
    // Reuse the elementRect and containerRect from above
    const targetPosition = 192; // header offset
    
    const isAlreadyPerfectlyPositioned = Math.abs(currentPosition - targetPosition) < 20; // 20px tolerance
    const cleanupDelay = isAlreadyPerfectlyPositioned ? 0 : 500; // No delay if perfect, 500ms if corrections might fire
    
    verbose.nav(`SMART CLEANUP: Element at ${currentPosition}px, target ${targetPosition}px, diff ${Math.abs(currentPosition - targetPosition)}px, delay ${cleanupDelay}ms`, 'scrolling.js');

    // Clear any existing cleanup timer and store the new one
    if (pendingNavigationCleanupTimer) {
      clearTimeout(pendingNavigationCleanupTimer);
    }

    // If scroll correction is needed, register it with the barrier
    if (!isAlreadyPerfectlyPositioned) {
      NavigationCompletionBarrier.registerProcess(NavigationProcess.SCROLL_CORRECTION);
    }

    pendingNavigationCleanupTimer = setTimeout(async () => {
      verbose.nav(`Navigation scroll complete for ${targetId}`, 'scrolling.js');
      pendingNavigationCleanupTimer = null; // Clear the reference

      // 🚦 Signal scroll completion to the barrier (DON'T clear flags directly - barrier handles that)
      NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_COMPLETE, true);

      // If scroll correction was registered, signal it too
      if (!isAlreadyPerfectlyPositioned) {
        NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_CORRECTION, true);
      }

      // 🎯 Hide loading indicator, then trigger hypercite glow
      await hideNavigationLoading();

      if (targetId.startsWith('hypercite_')) {
        if (!revealGhostIfTombstone(targetId)) {
          highlightTargetHypercite(targetId);
        }
      }

      // Mark this hash as "navigated to" for this page session.
      // Uses module-level Set so it resets on page reload (fresh loads re-navigate).
      if (window.location.hash.substring(1) === targetId) {
        navigatedHashes.add(targetId);
        verbose.nav(`Marked hash ${targetId} as navigated (session-level)`, 'scrolling.js');
      }

      // 🚀 iOS Safari fix: Resolve navigation Promise so callers know we're truly done
      if (lazyLoader._navigationResolve) {
        lazyLoader._navigationResolve({ success: true, targetId, element: targetElement });
        lazyLoader._navigationResolve = null;
        lazyLoader._navigationReject = null;
      }

    }, cleanupDelay);
  } else {
    console.error(`❌ Navigation failed - no ready target element found for: ${targetId}`);
    hideNavigationLoading();

    // 🚦 Signal failure to the barrier (it will handle flag cleanup)
    NavigationCompletionBarrier.completeProcess(NavigationProcess.SCROLL_COMPLETE, false);

    // 🚀 iOS Safari fix: Reject navigation Promise so callers know navigation failed
    if (lazyLoader._navigationReject) {
      lazyLoader._navigationReject(new Error(`Navigation failed - element not found: ${targetId}`));
      lazyLoader._navigationResolve = null;
      lazyLoader._navigationReject = null;
    }
  }
}

// Utility: wait for an element and then scroll to it.
function waitForElementAndScroll(targetId, maxAttempts = 10, attempt = 0) {
  const targetElement = document.getElementById(targetId);
  if (targetElement) {
    verbose.nav(`Target ID "${targetId}" found! Scrolling...`, 'scrolling.js');
    setTimeout(() => {
      scrollElementIntoMainContent(targetElement, 50);
    }, 150);
    return;
  }
  if (attempt >= maxAttempts) {
    console.warn(`❌ Gave up waiting for "${targetId}".`);
    return;
  }
  setTimeout(
    () => waitForElementAndScroll(targetId, maxAttempts, attempt + 1),
    200
  );
}

// findLineForCustomId removed — logic absorbed into navigation/resolveTargetChunk.js
