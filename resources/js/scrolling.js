// In scrolling.js

import { verbose } from './utilities/logger.js';

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
    console.log(`⏭️ SKIP RESTORATION: ${reason} - user was scrolling ${Date.now() - userScrollState.lastUserScrollTime}ms ago`);
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
  
  // Clear navigation flag after scroll completes
  setTimeout(() => {
    userScrollState.isNavigating = false;
  }, 1000);
  
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
  
  // Single correction after layout settles
  setTimeout(() => {
    if (shouldSkipScrollRestoration("scroll correction")) {
      return;
    }
    
    const elementRect = targetElement.getBoundingClientRect();
    const containerRect = scrollableContainer.getBoundingClientRect();
    const currentElementPosition = elementRect.top - containerRect.top;
    
    // Apply correction if element is significantly off target
    if (Math.abs(currentElementPosition - headerOffset) > 20) {
      const correctedOffset = elementOffset - headerOffset + (currentElementPosition - headerOffset);
      const correctedScrollTop = Math.max(0, correctedOffset);
      
      scrollableContainer.scrollTo({
        top: correctedScrollTop,
        behavior: "instant"
      });
    }
  }, 100);
  
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
    console.log(`Skipping non-tracked element: ${el.id}`);
    return false;
  }
  return ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "IMG"].includes(
    el.tagName
  );
}


// Adjusted helper: load default content if container is empty.
async function loadDefaultContent(lazyLoader) {
  console.log("Loading default content (first chunk)...");
  
  // Check if we already have nodes
  if (!lazyLoader.nodes || lazyLoader.nodes.length === 0) {
    console.log("No nodes in memory, trying to fetch from IndexedDB...");
    try {
      let cachedNodeChunks = await getNodeChunksFromIndexedDB(lazyLoader.bookId);
      if (cachedNodeChunks && cachedNodeChunks.length > 0) {
        console.log(`Found ${cachedNodeChunks.length} chunks in IndexedDB`);
        lazyLoader.nodes = cachedNodeChunks;
      } else {
        // Fallback: fetch markdown and parse
        console.log("No cached chunks found. Fetching main-text.md...");
        const response = await fetch(`/${lazyLoader.bookId}/main-text.md`);
        if (!response.ok) {
          throw new Error(`Failed to fetch markdown: ${response.status}`);
        }
        const markdown = await response.text();
        lazyLoader.nodes = parseMarkdownIntoChunksInitial(markdown);
        console.log(`Parsed ${lazyLoader.nodes.length} chunks from markdown`);
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
    console.log(`Loading ${firstChunks.length} chunks with ID 0`);
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
  
  console.log("Default content loaded successfully");
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
  // 🔍 DIAGNOSTIC: Entry point logging
  console.log('🔍 SCROLL DEBUG: ========== restoreScrollPosition() ENTRY ==========');
  console.log('🔍 SCROLL DEBUG: URL =', window.location.href);
  console.log('🔍 SCROLL DEBUG: URL hash =', window.location.hash);

  // Skip if content doesn't overflow (nothing to scroll)
  const wrapper = document.querySelector('.home-content-wrapper') ||
                  document.querySelector('.user-content-wrapper') ||
                  document.querySelector('.reader-content-wrapper');

  // 🔍 DIAGNOSTIC: Log current scroll state BEFORE any logic
  if (wrapper) {
    console.log('🔍 SCROLL DEBUG: Current scrollTop =', wrapper.scrollTop);
    console.log('🔍 SCROLL DEBUG: scrollHeight =', wrapper.scrollHeight, 'clientHeight =', wrapper.clientHeight);
    const existingChunks = wrapper.querySelectorAll('[data-chunk-id]');
    console.log('🔍 SCROLL DEBUG: Existing chunks in DOM =', existingChunks.length);
    if (existingChunks.length > 0) {
      const chunkIds = Array.from(existingChunks).map(c => c.getAttribute('data-chunk-id'));
      console.log('🔍 SCROLL DEBUG: Chunk IDs =', chunkIds.join(', '));
    }
  }

  if (wrapper && wrapper.scrollHeight <= wrapper.clientHeight && !window.location.hash) {
    console.log('🔍 SCROLL DEBUG: EARLY EXIT - content doesnt overflow and no hash target');
    return;
  }

  // Check if user is currently scrolling
  if (shouldSkipScrollRestoration("restoreScrollPosition")) {
    return;
  }

  // Skip if search toolbar is blocking navigation
  if (window.searchToolbarBlockingNavigation) {
    console.log(`⏭️ RESTORE SCROLL: Search toolbar blocking navigation, skipping restoration`);
    return;
  }

  // Skip if search toolbar is open - don't interfere with search UX
  if (isSearchToolbarOpen()) {
    console.log(`⏭️ RESTORE SCROLL: Search toolbar is open, skipping restoration`);
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
    console.log(`⏭️ RESTORE SCROLL: Skip flag is set, clearing and returning`);
    setSkipScrollRestoration(false); // Clear the flag for next time
    return;
  }

  // 🚀 FIX: Check if we're on a hyperlight URL path (like /book/HL_xxxxx)
  // If so, skip scroll restoration - BookToBookTransition will handle navigation
  const pathSegments = window.location.pathname.split('/').filter(Boolean);
  const isHyperlightPath = pathSegments.length >= 2 && pathSegments[1]?.startsWith('HL_');
  const isFootnotePath = pathSegments.length >= 2 && (pathSegments[1]?.includes('_Fn') || pathSegments[1]?.startsWith('Fn'));
  if (isHyperlightPath) {
    console.log(`⏭️ RESTORE SCROLL: Hyperlight path detected (${pathSegments[1]}), skipping scroll restoration`);
    return;
  }
  if (isFootnotePath) {
    console.log(`⏭️ RESTORE SCROLL: Footnote path detected (${pathSegments[1]}), skipping scroll restoration`);
    return;
  }

  // If we're navigating to an internal ID (like a highlight or footnote), prioritize that
  const targetInternalId = OpenHyperlightID || OpenFootnoteID;
  if (currentLazyLoader.isNavigatingToInternalId && targetInternalId) {
    console.log(`🔍 Prioritizing navigation to internal ID: ${targetInternalId}`);
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

  console.log(`🔍 RESTORE SCROLL: URL hash: "${targetId}", alreadyNavigated: ${alreadyNavigatedToHash}, explicit: ${hasExplicitTarget}`);
  
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
    console.log(`🔍 RESTORE SCROLL: No explicit target, checking saved positions...`);
    try {
      const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
      console.log('🔍 SCROLL DEBUG: Storage key =', scrollKey);

      // Try session storage first
      const sessionData = sessionStorage.getItem(scrollKey);
      console.log('🔍 SCROLL DEBUG: Raw sessionStorage data =', sessionData);
      if (sessionData && sessionData !== "0") {
        const parsed = JSON.parse(sessionData);
        console.log('🔍 SCROLL DEBUG: Parsed session data =', parsed);
        if (parsed?.elementId) {
          targetId = parsed.elementId;
          console.log(`📍 RESTORE SCROLL: Using saved session position: ${targetId}`);
        }
      }

      // Fallback to localStorage
      if (!targetId) {
        const localData = localStorage.getItem(scrollKey);
        console.log('🔍 SCROLL DEBUG: Raw localStorage data =', localData);
        if (localData && localData !== "0") {
          const parsed = JSON.parse(localData);
          console.log('🔍 SCROLL DEBUG: Parsed local data =', parsed);
          if (parsed?.elementId) {
            targetId = parsed.elementId;
            console.log(`📍 RESTORE SCROLL: Using saved local position: ${targetId}`);
          }
        }
      }
    } catch (e) {
      console.warn("Error reading saved scroll position", e);
    }
  } else if (currentLazyLoader.isNavigatingToInternalId) {
    console.log(`🎯 RESTORE SCROLL: Internal navigation in progress, IGNORING saved scroll positions`);
  } else {
    console.log(`🎯 RESTORE SCROLL: Explicit target found, IGNORING any saved scroll positions`);
  }

  console.log('🔍 SCROLL DEBUG: Final targetId after storage check =', targetId || '(empty)');

  if (!targetId) {
    // 🔍 DIAGNOSTIC: This is the problematic path
    console.log('🔍 SCROLL DEBUG: ⚠️ NO targetId - entering chunk 0 loading path');
    console.log('🔍 SCROLL DEBUG: WHY? Check if storage data was null/empty above');

    // Load first chunk when no saved position
    try {
      let cachedNodeChunks = await getNodeChunksFromIndexedDB(currentLazyLoader.bookId);
      console.log('🔍 SCROLL DEBUG: Got cachedNodeChunks from IndexedDB, count =', cachedNodeChunks?.length || 0);

      if (cachedNodeChunks?.length > 0) {
        // 🛡️ FIX: Check if content already exists in DOM (e.g., from bfcache)
        // If so, preserve it and let browser's scroll restoration work
        const existingChunks = currentLazyLoader.container.querySelectorAll('[data-chunk-id]');
        console.log('🔍 SCROLL DEBUG: Existing chunks in DOM =', existingChunks.length);

        if (existingChunks.length > 0) {
          console.log('🔍 SCROLL DEBUG: ✅ Content exists in DOM - preserving instead of clearing');
          console.log('🔍 SCROLL DEBUG: Current scrollTop =', currentLazyLoader.scrollableParent?.scrollTop);

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
        console.log('🔍 SCROLL DEBUG: No existing content, loading chunk 0');
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
        currentLazyLoader.nodes
          .filter(node => node.chunk_id === 0)
          .forEach(node => currentLazyLoader.loadChunk(node.chunk_id, "down"));
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
  console.log(`🎯 [LEGACY] showNavigationLoading called for ${targetId} - delegating to ProgressOverlayConductor`);

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
  console.log('🎯 [LEGACY] restoreNavigationOverlayIfNeeded called - now handled by ProgressOverlayEnactor._bindElements()');

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
  console.log("Initiating navigation to internal ID:", targetId);

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
    console.log(`🔒 Set isNavigatingToInternalId = true for ${targetId}`);

    // 🎯 Show loading indicator with progress tracking (only if requested)
    const progressIndicator = showOverlay ? showNavigationLoading(targetId) : { updateProgress: () => {}, setMessage: () => {} };

    // 🔒 NEW: Lock scroll position during navigation
    if (lazyLoader.lockScroll) {
      lazyLoader.lockScroll(`navigation to ${targetId}`);

      // 🔄 NEW: Detect user scroll and unlock immediately
      let userScrollDetected = false;
      const detectUserScroll = (event) => {
        if (!userScrollDetected && lazyLoader.scrollLocked) {
          console.log(`🔄 User scroll detected during navigation, unlocking immediately`);
          userScrollDetected = true;
          lazyLoader.unlockScroll();

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
      console.log(`🧹 Clearing session scroll cache for explicit navigation to: ${targetId}`);
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
      console.log(`Element ${targetId} needs scrolling, using ${delay}ms delay`);
    } else {
      // Element is already visible - minimal delay
      delay = 100;
      console.log(`Element ${targetId} already visible, using ${delay}ms delay`);
    }
  } else {
    // Element doesn't exist yet - will need loading and scrolling
    delay = 800;
    console.log(`Element ${targetId} not loaded yet, using ${delay}ms delay`);
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
        console.log(`🎯 Found hypercite ${targetId} in overlapping element:`, element);
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
      console.log(`📍 Found existing element ${targetId}, verifying readiness...`);
      
      if (progressIndicator) {
        progressIndicator.updateProgress(40, "Verifying element readiness...");
      }
      
      targetElement = await waitForElementReady(targetId, {
        maxAttempts: 5, // Quick check since element exists
        checkInterval: 20,
        container: lazyLoader.container
      });
      
      console.log(`✅ Existing element ${targetId} confirmed ready`);
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
    
    let targetChunkIndex = -1;
    if (/^\d+$/.test(targetId)) {
      // Compare targetId (which is startLine) to node.startLine.
      targetChunkIndex = lazyLoader.nodes.findIndex(
        node => node.startLine.toString() === targetId
      );
    } else {
      // Use custom logic for non-numeric IDs.
      const targetLine = findLineForCustomId(targetId, lazyLoader.nodes);
      if (targetLine === null) {
        console.warn(
          `No block found for target ID "${targetId}". ` +
            `Fallback: loading default view.`
        );
        // Instead of silently finishing, try the fallback.
        hideNavigationLoading();
        fallbackScrollPosition(lazyLoader);
        if (typeof lazyLoader.attachMarkListeners === "function") {
          lazyLoader.attachMarkListeners(lazyLoader.container);
        }
        lazyLoader.isNavigatingToInternalId = false;
        lazyLoader.pendingNavigationTarget = null;
        // Resolve with fallback flag so callers know we didn't reach target
        if (lazyLoader._navigationResolve) {
          lazyLoader._navigationResolve({ success: false, targetId, fallback: true });
          lazyLoader._navigationResolve = null;
          lazyLoader._navigationReject = null;
        }
        return;
      }
      targetChunkIndex = lazyLoader.nodes.findIndex(
        node => targetLine === node.startLine
      );
    }

    if (targetChunkIndex === -1) {
      console.warn(
        `No chunk found for target ID "${targetId}". ` +
          "Fallback: proceeding with default content."
      );
      hideNavigationLoading();
      fallbackScrollPosition(lazyLoader);
      if (typeof lazyLoader.attachMarkListeners === "function") {
        lazyLoader.attachMarkListeners(lazyLoader.container);
      }
      lazyLoader.isNavigatingToInternalId = false;
      lazyLoader.pendingNavigationTarget = null;
      // Resolve with fallback flag so callers know we didn't reach target
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
    
    // 🚀 Get the actual chunk_id of the target node, not array index
    const targetNode = lazyLoader.nodes[targetChunkIndex];
    const targetChunkId = targetNode.chunk_id;
    
    // Get all unique chunk_ids and sort them
    const allChunkIds = [...new Set(lazyLoader.nodes.map(n => n.chunk_id))].sort((a, b) => a - b);
    const targetChunkPosition = allChunkIds.indexOf(targetChunkId);
    
    // Load target chunk plus adjacent chunks
    const startChunkIndex = Math.max(0, targetChunkPosition - 1);
    const endChunkIndex = Math.min(allChunkIds.length - 1, targetChunkPosition + 1);
    const chunksToLoad = allChunkIds.slice(startChunkIndex, endChunkIndex + 1);
    
    console.log(`🎯 Target element "${targetId}" is in chunk_id: ${targetChunkId}`);
    console.log(`📦 Loading chunks: ${chunksToLoad.join(', ')} (target chunk position: ${targetChunkPosition})`);

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
      console.log(`🎯 Waiting for navigation target to be ready: ${targetId}`);
      
      targetElement = await waitForNavigationTarget(
        targetId, 
        lazyLoader.container,
        targetChunkId, // Now we know the exact chunk ID!
        { 
          maxWaitTime: 5000, // 5 second max wait
          requireVisible: false 
        }
      );
      
      console.log(`✅ Navigation target ready: ${targetId}`);
      elementsReady = true;
        
    } catch (error) {
      console.warn(`❌ Failed to wait for target element ${targetId}: ${error.message}. Trying fallback...`);
      
      // Fallback: try once more with querySelector in case it's there but not detected
      let fallbackTarget = lazyLoader.container.querySelector(`#${CSS.escape(targetId)}`);
      
      // For hypercites, also check overlapping elements in fallback
      if (!fallbackTarget && targetId.startsWith('hypercite_')) {
        const overlappingElements = lazyLoader.container.querySelectorAll('u[data-overlapping]');
        for (const element of overlappingElements) {
          const overlappingIds = element.getAttribute('data-overlapping');
          if (overlappingIds && overlappingIds.split(',').map(id => id.trim()).includes(targetId)) {
            console.log(`🎯 Found hypercite ${targetId} in overlapping element (fallback):`, element);
            fallbackTarget = element;
            break;
          }
        }
      }
      
      if (fallbackTarget) {
        console.log(`📍 Found target on fallback attempt: ${targetId}`);
        targetElement = fallbackTarget;
        elementsReady = true;
      } else {
        console.warn(`❌ Could not locate target element: ${targetId}`);
        hideNavigationLoading();
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
    console.log(`⏳ Waiting for layout completion before scrolling to: ${targetId}`);
    
    try {
      await pendingFirstChunkLoadedPromise;
      console.log(`✅ Layout complete, proceeding with scroll`);
    } catch (error) {
      console.warn(`⚠️ Layout promise failed, proceeding anyway: ${error.message}`);
    }
    
    if (progressIndicator) {
      progressIndicator.updateProgress(90, "Scrolling to target...");
    }
    
    // 🎯 FINAL SCROLL - Check if element is already visible before scrolling
    console.log(`🎯 FINAL SCROLL: Navigating to confirmed ready element: ${targetId}`);
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
    
    console.log(`🎯 Element visibility check: inViewport=${isInViewport}, inContainer=${isInContainer}, visible=${isAlreadyVisible}, position=${currentPosition}px, reasonablyPositioned=${isReasonablyPositioned}`);
    
    // Only scroll if element is not visible or poorly positioned
    if (!isAlreadyVisible || !isReasonablyPositioned) {
      if (scrollableParent && scrollableParent !== window) {
        console.log(`📍 Using consistent scroll for container: ${scrollableParent.className}`);
        scrollElementWithConsistentMethod(targetElement, scrollableParent, 192);
      } else {
        console.log(`📍 Using scrollIntoView for window scrolling`);
        targetElement.scrollIntoView({ 
          behavior: "smooth", 
          block: "start", 
          inline: "nearest" 
        });
      }
    } else {
      console.log(`✅ Element already visible and well-positioned - skipping scroll`);
    }
    
    // For highlights, open them after scrolling starts
    if (targetId.startsWith('HL_')) {
      setTimeout(() => {
        console.log(`Opening highlight after navigation: ${targetId}`);
        openHighlightById(targetId);
      }, 200);
    }

    // For footnotes, open them after scrolling starts (same as highlights)
    if (targetId.includes('_Fn') || targetId.startsWith('Fn')) {
      setTimeout(async () => {
        console.log(`Opening footnote after navigation: ${targetId}`);
        const { handleUnifiedContentClick } = await import('./hyperlitContainer/index.js');
        const footnoteElement = document.getElementById(targetId);
        if (footnoteElement) {
          handleUnifiedContentClick(footnoteElement);
        }
      }, 200);
    }

    // For hypercites, highlight the target and dim others
    if (targetId.startsWith('hypercite_')) {
      setTimeout(() => {
        console.log(`Highlighting target hypercite after navigation: ${targetId}`);
        highlightTargetHypercite(targetId, 500); // 500ms delay to let user see normal layout first
      }, 300);
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
    
    console.log(`🎯 SMART CLEANUP: Element at ${currentPosition}px, target ${targetPosition}px, diff ${Math.abs(currentPosition - targetPosition)}px, using ${cleanupDelay}ms delay`);

    // Clear any existing cleanup timer and store the new one
    if (pendingNavigationCleanupTimer) {
      clearTimeout(pendingNavigationCleanupTimer);
    }

    pendingNavigationCleanupTimer = setTimeout(() => {
      console.log(`🏁 Navigation complete for ${targetId}`);
      lazyLoader.isNavigatingToInternalId = false;
      lazyLoader.pendingNavigationTarget = null;
      pendingNavigationCleanupTimer = null; // Clear the reference

      // 🔓 Unlock scroll position
      if (lazyLoader.unlockScroll) {
        lazyLoader.unlockScroll();
      }

      // 🎯 Hide loading indicator
      hideNavigationLoading();

      // Mark this hash as "navigated to" for this page session.
      // Uses module-level Set so it resets on page reload (fresh loads re-navigate).
      if (window.location.hash.substring(1) === targetId) {
        navigatedHashes.add(targetId);
        console.log(`✅ Marked hash ${targetId} as navigated (session-level)`);
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
    lazyLoader.isNavigatingToInternalId = false;
    lazyLoader.pendingNavigationTarget = null;
    if (lazyLoader.unlockScroll) {
      lazyLoader.unlockScroll();
    }

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
    console.log(`✅ Target ID "${targetId}" found! Scrolling...`);
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

// Utility: find the line for a custom id in content, hypercites, and hyperlights.
function findLineForCustomId(targetId, nodes) {
  // Normalize for case-insensitive comparisons.
  const normalizedTarget = targetId.toLowerCase();
  // Create a regex to look in content for an element with the matching id.
  const regex = new RegExp(`id=['"]${targetId}['"]`, "i");

  // Iterate over each node in nodes.
  for (let node of nodes) {
    // Check if the content has an element with the target id.
    if (node.content && regex.test(node.content)) {
      return node.startLine;
    }

    // Check in hypercites array.
    if (Array.isArray(node.hypercites)) {
      for (let cite of node.hypercites) {
        if (
          cite.hyperciteId &&
          cite.hyperciteId.toLowerCase() === normalizedTarget
        ) {
          return node.startLine;
        }
      }
    }

    // Check in hyperlights array.
    if (Array.isArray(node.hyperlights)) {
      for (let light of node.hyperlights) {
        if (
          light.highlightID &&
          light.highlightID.toLowerCase() === normalizedTarget
        ) {
          return node.startLine;
        }
      }
    }
  }
  // Return null if no match is found.
  return null;
}
