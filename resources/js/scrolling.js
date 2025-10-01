// In scrolling.js

import { book, OpenHyperlightID } from "./app.js";
import { openHighlightById } from './hyperLights.js';
import {
  getNodeChunksFromIndexedDB,
  getLocalStorageKey
} from "./cache-indexedDB.js";
import { parseMarkdownIntoChunksInitial } from "./convert-markdown.js";
import { currentLazyLoader, pendingFirstChunkLoadedPromise } from "./initializePage.js";
import { repositionSentinels } from "./lazyLoaderFactory.js"; // if exported
import {
  waitForNavigationTarget,
  waitForElementReady,
  waitForChunkLoadingComplete
} from "./domReadiness.js";
import { highlightTargetHypercite } from "./hyperCites.js";
import { shouldSkipScrollRestoration as shouldSkipScrollRestorationGlobal, setSkipScrollRestoration } from "./operationState.js";

// ========= Scrolling Helper Functions =========

// Global scroll state management to prevent restoration interference
let userScrollState = {
  isScrolling: false,
  lastUserScrollTime: 0,
  scrollTimeout: null,
  isNavigating: false // NEW: Flag to ignore navigation scrolls
};

function detectUserScrollStart() {
  // Don't treat navigation scrolls as user scrolls
  if (userScrollState.isNavigating) {
    console.log(`🎯 NAVIGATION SCROLL - Ignoring as user scroll`);
    return;
  }
  
  userScrollState.isScrolling = true;
  userScrollState.lastUserScrollTime = Date.now();
  
  // Clear any existing timeout
  if (userScrollState.scrollTimeout) {
    clearTimeout(userScrollState.scrollTimeout);
  }
  
  console.log(`🔄 USER SCROLL DETECTED - Disabling all scroll restoration for 2 seconds`);
  
  // Reset after 2 seconds of no scroll events
  userScrollState.scrollTimeout = setTimeout(() => {
    userScrollState.isScrolling = false;
    console.log(`✅ USER SCROLL ENDED - Re-enabling scroll restoration`);
  }, 2000);
}

function isUserCurrentlyScrolling() {
  const timeSinceLastScroll = Date.now() - userScrollState.lastUserScrollTime;
  return userScrollState.isScrolling || timeSinceLastScroll < 2000;
}

export function shouldSkipScrollRestoration(reason = "user scrolling") {
  const skip = isUserCurrentlyScrolling();
  if (skip) {
    console.log(`⏭️ SKIP RESTORATION: ${reason} - user was scrolling ${Date.now() - userScrollState.lastUserScrollTime}ms ago`);
  }
  return skip;
}

// Set up user scroll detection for a container
export function setupUserScrollDetection(scrollableContainer) {
  if (!scrollableContainer) {
    console.warn("No scrollable container provided for user scroll detection");
    return;
  }
  
  console.log(`📡 Setting up user scroll detection for container: ${scrollableContainer.className || scrollableContainer.id}`);
  
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
  // `book` is the ID of your <div class="main-content">
  const contentContainer = document.getElementById(book);
  if (!contentContainer) {
    console.error(`Content container with id ${book} not found!`);
    // Fallback to basic scroll if container not found
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  // Find the actual scrollable parent (e.g., .reader-content-wrapper)
  const scrollableParent = contentContainer.closest(".reader-content-wrapper") ||
                           contentContainer.closest(".home-content-wrapper");

  if (!scrollableParent) {
    console.error("ERROR: No scrollable parent wrapper found for content container!");
    // Fallback to basic scroll if scrollable parent not found
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
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
  
  // Check if we already have nodeChunks
  if (!lazyLoader.nodeChunks || lazyLoader.nodeChunks.length === 0) {
    console.log("No nodeChunks in memory, trying to fetch from IndexedDB...");
    try {
      let cachedNodeChunks = await getNodeChunksFromIndexedDB(lazyLoader.bookId);
      if (cachedNodeChunks && cachedNodeChunks.length > 0) {
        console.log(`Found ${cachedNodeChunks.length} chunks in IndexedDB`);
        lazyLoader.nodeChunks = cachedNodeChunks;
      } else {
        // Fallback: fetch markdown and parse
        console.log("No cached chunks found. Fetching main-text.md...");
        const response = await fetch(`/markdown/${lazyLoader.bookId}/main-text.md`);
        if (!response.ok) {
          throw new Error(`Failed to fetch markdown: ${response.status}`);
        }
        const markdown = await response.text();
        lazyLoader.nodeChunks = parseMarkdownIntoChunksInitial(markdown);
        console.log(`Parsed ${lazyLoader.nodeChunks.length} chunks from markdown`);
      }
    } catch (error) {
      console.error("Error loading content:", error);
      throw error; // Re-throw to handle in the calling function
    }
  }
  
  // Clear container and load first chunk
  lazyLoader.container.innerHTML = "";
  
  // Find chunks with chunk_id === 0
  const firstChunks = lazyLoader.nodeChunks.filter(node => node.chunk_id === 0);
  if (firstChunks.length === 0) {
    console.warn("No chunks with ID 0 found! Loading first available chunk instead.");
    if (lazyLoader.nodeChunks.length > 0) {
      lazyLoader.loadChunk(lazyLoader.nodeChunks[0].chunk_id, "down");
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
      targetElement.classList.add("active");
      return;
    }
  }

  // Fallback to top of page
  lazyLoader.container.scrollTo({ top: 0, behavior: "smooth" });
}



export async function restoreScrollPosition() {
  console.log("restoring scroll position...");

  // Check if user is currently scrolling
  if (shouldSkipScrollRestoration("restoreScrollPosition")) {
    return;
  }

  if (!currentLazyLoader) {
    console.error("Lazy loader instance not available!");
    return;
  }

  // 🚀 FIX: Skip if we're already navigating to a target
  // This prevents race conditions with BookToBookTransition and other navigation pathways
  if (currentLazyLoader.isNavigatingToInternalId) {
    console.log(`⏭️ RESTORE SCROLL: Navigation already in progress, skipping restore`);
    return;
  }

  console.log(
    "📌 Attempting to restore scroll position for container:",
    currentLazyLoader.bookId
  );

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
  if (isHyperlightPath) {
    console.log(`⏭️ RESTORE SCROLL: Hyperlight path detected (${pathSegments[1]}), skipping scroll restoration`);
    return;
  }

  // If we're navigating to an internal ID (like a highlight), prioritize that
  if (currentLazyLoader.isNavigatingToInternalId && OpenHyperlightID) {
    console.log(`🔍 Prioritizing navigation to highlight: ${OpenHyperlightID}`);
    navigateToInternalId(OpenHyperlightID, currentLazyLoader, false); // No overlay for internal highlight navigation
    return; // Exit early, don't proceed with normal scroll restoration
  }

  // Read target id from URL hash first.
  let targetId = window.location.hash.substring(1);

  // 🚀 FIX: Check if we've already navigated to this hash (using history state)
  // If we have, treat it like we have no explicit target (allow scroll position to override)
  const historyState = window.history.state;
  const alreadyNavigatedToHash = historyState && historyState.navigatedToHash === targetId;
  const hasExplicitTarget = !!targetId && !alreadyNavigatedToHash;

  console.log(`🔍 RESTORE SCROLL: URL hash: "${targetId}", alreadyNavigated: ${alreadyNavigatedToHash}, explicit: ${hasExplicitTarget}`);
  
  // Show overlay for external navigation targets
  let overlayShown = false;
  const existingOverlay = navigationModal || document.getElementById('initial-navigation-overlay');
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

      // Try session storage first
      const sessionData = sessionStorage.getItem(scrollKey);
      if (sessionData && sessionData !== "0") {
        const parsed = JSON.parse(sessionData);
        if (parsed?.elementId) {
          targetId = parsed.elementId;
          console.log(`📍 RESTORE SCROLL: Using saved session position: ${targetId}`);
        }
      }

      // Fallback to localStorage
      if (!targetId) {
        const localData = localStorage.getItem(scrollKey);
        if (localData && localData !== "0") {
          const parsed = JSON.parse(localData);
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

  if (!targetId) {
    // Load first chunk when no saved position
    try {
      let cachedNodeChunks = await getNodeChunksFromIndexedDB(currentLazyLoader.bookId);
      
      if (cachedNodeChunks?.length > 0) {
        currentLazyLoader.nodeChunks = cachedNodeChunks;
        currentLazyLoader.container.innerHTML = "";
        currentLazyLoader.nodeChunks
          .filter(node => node.chunk_id === 0)
          .forEach(node => currentLazyLoader.loadChunk(node.chunk_id, "down"));
        return;
      }
      
      // Fallback to markdown fetch
      const response = await fetch(`/markdown/${book}/main-text.md`);
      const markdown = await response.text();
      currentLazyLoader.nodeChunks = parseMarkdownIntoChunksInitial(markdown);
      currentLazyLoader.nodeChunks
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

// Navigation loading indicator with overlay and progress bar
let navigationModal = null;

export function showNavigationLoading(targetId) {
  console.log(`🎯 LOADING: Starting navigation to ${targetId}`);

  // Store in sessionStorage so overlay persists across page transitions
  sessionStorage.setItem('navigationOverlayActive', 'true');
  sessionStorage.setItem('navigationTargetId', targetId);

  // 🧹 CRITICAL: Remove any stale navigation overlays from previous SPA transitions
  const staleOverlays = document.querySelectorAll('.navigation-overlay:not(#initial-navigation-overlay)');
  if (staleOverlays.length > 0) {
    console.warn(`🧹 Removing ${staleOverlays.length} stale navigation overlays`);
    staleOverlays.forEach(overlay => overlay.remove());
  }

  // Try to use existing blade template overlay first
  const initialOverlay = document.getElementById('initial-navigation-overlay');
  if (initialOverlay) {
    navigationModal = initialOverlay;
    navigationModal.style.display = 'block';
  } else {
    // Fallback: create overlay if blade template overlay doesn't exist
    navigationModal = document.createElement("div");
    navigationModal.className = "navigation-overlay";

    // Add styles (only if not already added)
    if (!document.getElementById('navigation-overlay-styles')) {
      const style = document.createElement('style');
      style.id = 'navigation-overlay-styles';
      style.textContent = `
        .navigation-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.3);
          z-index: 10000;
          pointer-events: none; /* Don't block clicks - overlay is visual only */
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(navigationModal);
  }
  
  return {
    updateProgress: (percent, message) => {
      // No-op for now
    },
    setMessage: (message) => {
      // No-op for now  
    }
  };
}

export async function hideNavigationLoading() {
  console.log(`🎯 LOADING: Navigation complete`);
  
  // Clear sessionStorage flags
  sessionStorage.removeItem('navigationOverlayActive');
  sessionStorage.removeItem('navigationTargetId');
  
  // Use our progress completion animation instead of directly hiding
  try {
    const { hidePageLoadProgress } = await import('./reader-DOMContentLoaded.js');
    await hidePageLoadProgress();
    console.log('🎯 Initial overlay hidden with completion animation');
  } catch (e) {
    console.warn('Could not import progress functions, falling back to direct hide:', e);
    // Fallback to direct hide if import fails
    const initialOverlay = document.getElementById('initial-navigation-overlay');
    if (initialOverlay) {
      initialOverlay.style.display = 'none';
      console.log('🎯 Initial overlay hidden (fallback)');
    }
  }
  
  if (navigationModal) {
    // Check if it's the blade template overlay or a created one
    if (navigationModal.id === 'initial-navigation-overlay') {
      // It's the blade template overlay, already handled above
      console.log('🎯 Blade template overlay already handled');
    } else {
      // It's a dynamically created overlay, remove it
      navigationModal.remove();
    }
    navigationModal = null;
  }
}

// Function to restore overlay on page load if it was active during navigation
export function restoreNavigationOverlayIfNeeded() {
  const overlayActive = sessionStorage.getItem('navigationOverlayActive');
  const targetId = sessionStorage.getItem('navigationTargetId');
  
  // 🔥 DONT RESTORE OVERLAY FOR IMPORTED BOOKS
  const isImportedBook = sessionStorage.getItem('imported_book_flag');
  if (isImportedBook) {
    console.log(`🎯 SKIPPING overlay restore for imported book: ${isImportedBook}`);
    // Clear the overlay flags to prevent future restoration
    sessionStorage.removeItem('navigationOverlayActive');
    sessionStorage.removeItem('navigationTargetId');
    return;
  }
  
  if (overlayActive === 'true' && targetId) {
    console.log(`🎯 RESTORING: Navigation overlay for ${targetId} after page transition`);
    
    // Recreate the overlay immediately
    navigationModal = document.createElement("div");
    navigationModal.className = "navigation-overlay";
    
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .navigation-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.3);
        z-index: 10000;
      }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(navigationModal);
    
    return true; // Indicate overlay was restored
  }
  
  return false; // No overlay to restore
}

export function navigateToInternalId(targetId, lazyLoader, showOverlay = true) {
  if (!lazyLoader) {
    console.error("Lazy loader instance not provided!");
    return;
  }
  console.log("Initiating navigation to internal ID:", targetId);

  // 🚀 CRITICAL: Set flag IMMEDIATELY to prevent race conditions
  // This prevents restoreScrollPosition() from interfering
  lazyLoader.isNavigatingToInternalId = true;
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
      targetChunkIndex = lazyLoader.nodeChunks.findIndex(
        node => node.startLine.toString() === targetId
      );
    } else {
      // Use custom logic for non-numeric IDs.
      const targetLine = findLineForCustomId(targetId, lazyLoader.nodeChunks);
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
        return;
      }
      targetChunkIndex = lazyLoader.nodeChunks.findIndex(
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
      return;
    }

    // Clear the container and load the chunk (plus adjacent chunks).
    if (progressIndicator) {
      progressIndicator.updateProgress(50, "Clearing container and preparing to load chunks...");
    }
    
    lazyLoader.container.innerHTML = "";
    lazyLoader.currentlyLoadedChunks.clear();
    
    // 🚀 Get the actual chunk_id of the target node, not array index
    const targetNode = lazyLoader.nodeChunks[targetChunkIndex];
    const targetChunkId = targetNode.chunk_id;
    
    // Get all unique chunk_ids and sort them
    const allChunkIds = [...new Set(lazyLoader.nodeChunks.map(n => n.chunk_id))].sort((a, b) => a - b);
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
    
    setTimeout(() => {
      console.log(`🏁 Navigation complete for ${targetId}`);
      lazyLoader.isNavigatingToInternalId = false;

      // 🔓 Unlock scroll position
      if (lazyLoader.unlockScroll) {
        lazyLoader.unlockScroll();
      }

      // 🎯 Hide loading indicator
      hideNavigationLoading();

      // 🚀 FIX: Mark this hash as "navigated to" in history state
      // This prevents refresh from going back to hash (allows scroll position to override)
      if (window.location.hash.substring(1) === targetId) {
        try {
          const currentState = window.history.state || {};
          window.history.replaceState(
            { ...currentState, navigatedToHash: targetId },
            '',
            window.location.href
          );
          console.log(`✅ Marked hash ${targetId} as navigated in history state`);
        } catch (error) {
          console.warn('Could not update history state:', error);
        }
      }

    }, cleanupDelay);
  } else {
    console.error(`❌ Navigation failed - no ready target element found for: ${targetId}`);
    hideNavigationLoading();
    lazyLoader.isNavigatingToInternalId = false;
    if (lazyLoader.unlockScroll) {
      lazyLoader.unlockScroll();
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
function findLineForCustomId(targetId, nodeChunks) {
  // Normalize for case-insensitive comparisons.
  const normalizedTarget = targetId.toLowerCase();
  // Create a regex to look in content for an element with the matching id.
  const regex = new RegExp(`id=['"]${targetId}['"]`, "i");

  // Iterate over each node in nodeChunks.
  for (let node of nodeChunks) {
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
