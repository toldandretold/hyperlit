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

// NEW: Consistent scroll method to be used throughout the application
function scrollElementWithConsistentMethod(targetElement, scrollableContainer, headerOffset = 192) {
  if (!targetElement || !scrollableContainer) {
    console.error("Missing target element or scrollable container for consistent scroll");
    return;
  }
  
  // Mark as navigation scroll to prevent user scroll detection interference
  userScrollState.isNavigating = true;
  console.log(`🎯 CONSISTENT SCROLL: Scrolling ${targetElement.id || 'unnamed element'} with offset ${headerOffset}px (navigation mode)`);
  
  // Clear navigation flag after scroll completes
  setTimeout(() => {
    userScrollState.isNavigating = false;
    console.log(`🎯 NAVIGATION SCROLL COMPLETE - User scroll detection re-enabled`);
  }, 1000);
  
  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = scrollableContainer.getBoundingClientRect();
  
  // Calculate element's absolute position within scrollable content
  const elementOffsetTop = (elementRect.top - containerRect.top) + scrollableContainer.scrollTop;
  
  // ALTERNATIVE: Try using offsetTop for more stable positioning
  let alternativeOffset = 0;
  let el = targetElement;
  while (el && el !== scrollableContainer) {
    alternativeOffset += el.offsetTop;
    el = el.offsetParent;
  }
  console.log(`🔍 OFFSET COMPARISON: getBoundingClientRect method = ${elementOffsetTop}px, offsetTop method = ${alternativeOffset}px`);
  
  // Use the offsetTop method instead for more stable calculation
  const targetScrollTop = Math.max(0, alternativeOffset - headerOffset);
  console.log(`🔧 USING OFFSETTOP METHOD: Scrolling to ${targetScrollTop}px instead of ${elementOffsetTop - headerOffset}px`);
  
  console.log(`🎯 Element at ${elementOffsetTop}px, scrolling to ${targetScrollTop}px (offset: ${headerOffset}px)`);
  console.log(`🎯 Container viewport: top=${containerRect.top}, height=${scrollableContainer.clientHeight}px`);
  
  // DEBUG: Log detailed container info
  console.log(`📊 CONTAINER DEBUG:`);
  console.log(`  - Scrollable container: ${scrollableContainer.className}`);
  console.log(`  - Container rect: top=${containerRect.top}, left=${containerRect.left}, width=${containerRect.width}, height=${containerRect.height}`);
  console.log(`  - Container scroll: scrollTop=${scrollableContainer.scrollTop}, scrollLeft=${scrollableContainer.scrollLeft}`);
  console.log(`  - Element rect: top=${elementRect.top}, left=${elementRect.left}, width=${elementRect.width}, height=${elementRect.height}`);
  console.log(`  - Calculated element offset in container: ${elementOffsetTop}px`);
  
  // No position monitoring during instant scroll to avoid interference
  
  // Apply scroll with instant behavior to avoid animation conflicts with user input
  scrollableContainer.scrollTo({
    top: targetScrollTop,
    behavior: "instant"
  });
  
  // Immediate check - is the element currently visible?
  const isCurrentlyVisible = elementRect.top >= containerRect.top && 
                             elementRect.bottom <= containerRect.bottom &&
                             elementRect.left >= containerRect.left && 
                             elementRect.right <= containerRect.right;
  console.log(`🎯 Element currently visible before scroll: ${isCurrentlyVisible}`);
  
  // 🚨 ROOT CAUSE DEBUGGING: Comprehensive logging to understand cross-page navigation issues
  let initialScrollPosition = scrollableContainer.scrollTop;
  let initialElementPosition = null;
  let initialContainerHeight = scrollableContainer.scrollHeight;
  
  // Record initial state
  setTimeout(() => {
    const initialRect = targetElement.getBoundingClientRect();
    const initialContainerRect = scrollableContainer.getBoundingClientRect();
    initialElementPosition = initialRect.top - initialContainerRect.top;
    
    console.log(`🔍 INITIAL STATE RECORDED:`);
    console.log(`  - Initial scroll position: ${initialScrollPosition}px`);
    console.log(`  - Initial element position: ${initialElementPosition}px from container top`);
    console.log(`  - Initial container height: ${initialContainerHeight}px`);
    console.log(`  - Target header offset: ${headerOffset}px`);
  }, 10);
  
  // Monitor for content changes that might affect positioning
  let contentChangeCount = 0;
  const contentObserver = new MutationObserver((mutations) => {
    contentChangeCount++;
    const currentHeight = scrollableContainer.scrollHeight;
    const heightChange = currentHeight - initialContainerHeight;
    
    console.log(`🔄 CONTENT CHANGE #${contentChangeCount}:`);
    console.log(`  - Container height changed from ${initialContainerHeight}px to ${currentHeight}px`);
    console.log(`  - Height difference: ${heightChange}px`);
    
    if (Math.abs(heightChange) > 1000) {
      console.log(`🚨 MAJOR CONTENT CHANGE DETECTED: ${heightChange}px height difference!`);
      
      // Check current element position after this change
      const currentRect = targetElement.getBoundingClientRect();
      const currentContainerRect = scrollableContainer.getBoundingClientRect();
      const currentPosition = currentRect.top - currentContainerRect.top;
      const currentScroll = scrollableContainer.scrollTop;
      
      console.log(`  - Element moved from ${initialElementPosition}px to ${currentPosition}px`);
      console.log(`  - Scroll position: ${currentScroll}px (was ${initialScrollPosition}px)`);
      console.log(`  - Element movement: ${currentPosition - initialElementPosition}px`);
      
      // Try to identify what kind of content change this was
      const chunks = scrollableContainer.querySelectorAll('.chunk');
      const totalChunkHeight = Array.from(chunks).reduce((sum, chunk) => sum + chunk.offsetHeight, 0);
      console.log(`  - Current chunks: ${chunks.length}, total height: ${totalChunkHeight}px`);
    }
    
    initialContainerHeight = currentHeight;
  });
  
  contentObserver.observe(scrollableContainer, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false
  });
  
  // Single smart correction - wait for layout to settle then fix once
  setTimeout(() => {
    // Disconnect the observer
    contentObserver.disconnect();
    console.log(`🔍 TOTAL CONTENT CHANGES OBSERVED: ${contentChangeCount}`);
    
    // Skip correction if user started scrolling
    if (shouldSkipScrollRestoration("scroll correction")) {
      return;
    }
    
    const actualPosition = scrollableContainer.scrollTop;
    const elementRect = targetElement.getBoundingClientRect();
    const containerRect = scrollableContainer.getBoundingClientRect();
    const currentElementPosition = elementRect.top - containerRect.top;
    
    console.log(`🔍 SINGLE CORRECTION CHECK: Element at ${currentElementPosition}px from top, scroll position ${actualPosition}px`);
    
    // DEBUG: Compare container positions between initial and correction
    console.log(`📊 CORRECTION CONTAINER DEBUG:`);
    console.log(`  - Container rect NOW: top=${containerRect.top}, left=${containerRect.left}, width=${containerRect.width}, height=${containerRect.height}`);
    console.log(`  - Container was at top=0 initially, now at top=${containerRect.top} (moved ${containerRect.top}px DOWN)`);
    console.log(`  - Element rect NOW: top=${elementRect.top}, height=${elementRect.height}`);
    console.log(`  - Position shift: ${Math.abs(currentElementPosition - headerOffset)}px off target`);
    console.log(`  - Element moved from initial ${initialElementPosition}px to ${currentElementPosition}px (${currentElementPosition - initialElementPosition}px change)`);
    
    // If element is significantly off target, fix it once
    if (Math.abs(currentElementPosition - headerOffset) > 20) {
      console.log(`🔧 APPLYING SINGLE CORRECTION: Element ${Math.abs(currentElementPosition - headerOffset)}px off target`);
      const freshElementRect = targetElement.getBoundingClientRect();
      const freshContainerRect = scrollableContainer.getBoundingClientRect();
      const freshElementOffset = (freshElementRect.top - freshContainerRect.top) + scrollableContainer.scrollTop;
      const correctedScrollTop = Math.max(0, freshElementOffset - headerOffset);
      
      scrollableContainer.scrollTo({
        top: correctedScrollTop,
        behavior: "instant"
      });
      
      console.log(`🔧 Correction applied: scrolled from ${actualPosition}px to ${correctedScrollTop}px`);
      
      // Final verification - but NO more corrections
      setTimeout(() => {
        const finalRect = targetElement.getBoundingClientRect();
        const finalContainerRect = scrollableContainer.getBoundingClientRect();
        const finalPosition = finalRect.top - finalContainerRect.top;
        console.log(`✅ FINAL POSITION: Element at ${finalPosition}px from top (should be ${headerOffset}px)`);
      }, 50);
    } else {
      console.log(`✅ POSITION OK: Element correctly positioned, no correction needed`);
    }
  }, 100); // Faster correction to minimize visible jump
  
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
 * Fallback function that first tries to load 
 * a previously saved scroll position (if available),
 * otherwise scrolls to the top of the container.
 */
async function fallbackScrollPosition(lazyLoader) {
  console.log("Falling back to saved scroll position or top of page...");
  
  // Check if user is currently scrolling
  if (shouldSkipScrollRestoration("fallbackScrollPosition")) {
    return;
  }

  // Check specifically for chunk elements
  const chunkElements = Array.from(lazyLoader.container.children).filter(
    el => el.classList.contains("chunk")
  );
  
  console.log(`Container has ${lazyLoader.container.children.length} total children and ${chunkElements.length} chunk elements`);
  
  // If no chunks, force load the default content
  if (chunkElements.length === 0) {
    console.log("Container has no chunk elements, loading default content first...");
    try {
      // Keep the sentinels but remove anything else
      const topSentinel = lazyLoader.container.querySelector(`#${lazyLoader.bookId}-top-sentinel`);
      const bottomSentinel = lazyLoader.container.querySelector(`#${lazyLoader.bookId}-bottom-sentinel`);
      
      // Clear container but preserve sentinels
      lazyLoader.container.innerHTML = "";
      if (topSentinel) lazyLoader.container.appendChild(topSentinel);
      if (bottomSentinel) lazyLoader.container.appendChild(bottomSentinel);
      
      // Reset loaded chunks tracking
      lazyLoader.currentlyLoadedChunks = new Set();
      
      await loadDefaultContent(lazyLoader);
      console.log("Default content loaded successfully");
      
      // Debug what was loaded
      const afterLoadChunks = Array.from(lazyLoader.container.children).filter(
        el => el.classList.contains("chunk")
      );
      console.log(`After loading, container has ${afterLoadChunks.length} chunk elements`);
    } catch (error) {
      console.error("Failed to load default content:", error);
      // Emergency fallback - just put some text
      const errorDiv = document.createElement('div');
      errorDiv.className = "chunk";
      errorDiv.innerHTML = "<p>Unable to load content. Please refresh the page.</p>";
      
      // Insert between sentinels
      const bottomSentinel = lazyLoader.container.querySelector(`#${lazyLoader.bookId}-bottom-sentinel`);
      if (bottomSentinel) {
        lazyLoader.container.insertBefore(errorDiv, bottomSentinel);
      } else {
        lazyLoader.container.appendChild(errorDiv);
      }
      return;
    }
  } else {
    console.log("Container already has chunk elements, proceeding with scroll positioning");
    // Debug what chunks are there
    chunkElements.forEach((el, i) => {
      console.log(`Chunk element ${i}: id=${el.id}`);
    });
  }

  // Now try to find a saved position
  const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
  let savedTargetId = null;
  
  // Try session storage first
  try {
    const sessionSavedId = sessionStorage.getItem(scrollKey);
    if (sessionSavedId && sessionSavedId !== "0") {
      const parsed = JSON.parse(sessionSavedId);
      if (parsed && parsed.elementId) {
        savedTargetId = parsed.elementId;
        console.log(`Found saved position in sessionStorage: ${savedTargetId}`);
      }
    }
  } catch (e) {
    console.warn("sessionStorage not available or parse error", e);
  }
  
  // Try local storage if session storage didn't have anything
  if (!savedTargetId) {
    try {
      const localSavedId = localStorage.getItem(scrollKey);
      if (localSavedId && localSavedId !== "0") {
        const parsed = JSON.parse(localSavedId);
        if (parsed && parsed.elementId) {
          savedTargetId = parsed.elementId;
          console.log(`Found saved position in localStorage: ${savedTargetId}`);
        }
      }
    } catch (e) {
      console.warn("localStorage not available or parse error", e);
    }
  }

  // If we have a saved target and it exists, scroll to it
  if (savedTargetId) {
    let targetElement = lazyLoader.container.querySelector(
      `#${CSS.escape(savedTargetId)}`
    );
    if (targetElement) {
      console.log(`Scrolling to previously saved element: ${savedTargetId}`);
      scrollElementIntoMainContent(targetElement, 50);
      targetElement.classList.add("active");
      return;
    } else {
      console.log(`Saved element ID ${savedTargetId} not found in current DOM`);
    }
  }

  // Fallback: simply scroll to the top
  console.log("No saved scroll position available or element not found. Scrolling to top.");
  lazyLoader.container.scrollTo({ top: 0, behavior: "smooth" });
  
  // Make sure we have at least one visible element
  if (lazyLoader.container.children.length === 0) {
    console.warn("Container still empty after fallback attempts!");
    lazyLoader.container.innerHTML = "<p>Content could not be loaded. Please refresh the page.</p>";
  }
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
  console.log(
    "📌 Attempting to restore scroll position for container:",
    currentLazyLoader.bookId
  );

  // If we're navigating to an internal ID (like a highlight), prioritize that
  if (currentLazyLoader.isNavigatingToInternalId && OpenHyperlightID) {
    console.log(`🔍 Prioritizing navigation to highlight: ${OpenHyperlightID}`);
    navigateToInternalId(OpenHyperlightID, currentLazyLoader);
    return; // Exit early, don't proceed with normal scroll restoration
  }

  // Read target id from URL hash first.
  let targetId = window.location.hash.substring(1);
  const hasExplicitTarget = !!targetId; // Track if we have an explicit navigation target
  
  console.log(`🔍 URL hash target: "${targetId}", explicit: ${hasExplicitTarget}`);
  
  // Show overlay immediately if we have a URL hash target (browser navigation)
  // BUT only if overlay is not already active from page transition
  let overlayShown = false;
  const existingOverlay = navigationModal || document.getElementById('initial-navigation-overlay');
  const overlayAlreadyVisible = existingOverlay && (
    existingOverlay.style.display !== 'none' && 
    existingOverlay.style.display !== ''
  );
  
  if (hasExplicitTarget && !overlayAlreadyVisible) {
    showNavigationLoading(targetId);
    overlayShown = true;
  } else if (overlayAlreadyVisible) {
    // Overlay already exists from page transition
    overlayShown = true;
    console.log(`🎯 Using existing overlay from page transition for: ${targetId}`);
  }

  // Only use saved scroll position if there's no explicit target in URL
  if (!hasExplicitTarget) {
    try {
      const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
      const sessionSavedId = sessionStorage.getItem(scrollKey);
      if (sessionSavedId && sessionSavedId !== "0") {
        const parsed = JSON.parse(sessionSavedId);
        if (parsed && parsed.elementId) {
          targetId = parsed.elementId;
          console.log(`📌 Using saved session position: ${targetId}`);
        }
      }
    } catch (e) {
      console.log("⚠️ sessionStorage not available or parse error", e);
    }
    
    // Fallback to localStorage only if no session data
    if (!targetId) {
      try {
        const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
        const localSavedId = localStorage.getItem(scrollKey);
        if (localSavedId && localSavedId !== "0") {
          const parsed = JSON.parse(localSavedId);
          if (parsed && parsed.elementId) {
            targetId = parsed.elementId;
            console.log(`📌 Using saved local position: ${targetId}`);
          }
        }
      } catch (e) {
        console.log("⚠️ localStorage not available or parse error", e);
      }
    }
  } else {
    console.log(`🎯 Explicit target found in URL, ignoring saved scroll positions`);
  }

  if (!targetId) {
    // No saved scroll position: load first chunk.
    console.log("🟢 No saved position found. Loading first chunk...");
    let cachedNodeChunks = await getNodeChunksFromIndexedDB(
      currentLazyLoader.bookId
    );
    if (cachedNodeChunks && cachedNodeChunks.length > 0) {
      console.log("✅ Found nodeChunks in IndexedDB. Loading first chunk...");
      currentLazyLoader.nodeChunks = cachedNodeChunks;
      currentLazyLoader.container.innerHTML = "";
      currentLazyLoader.nodeChunks
        .filter(node => node.chunk_id === 0)
        .forEach(node => currentLazyLoader.loadChunk(node.chunk_id, "down"));
      return;
    }
    // Fallback: fetch markdown and parse.
    console.log("⚠️ No cached chunks found. Fetching from main-text.md...");
    try {
      const response = await fetch(`/markdown/${book}/main-text.md`);
      const markdown = await response.text();
      currentLazyLoader.nodeChunks = parseMarkdownIntoChunksInitial(markdown);
      currentLazyLoader.nodeChunks
        .filter(node => node.chunk_id === 0)
        .forEach(node => currentLazyLoader.loadChunk(node.chunk_id, "down"));
    } catch (error) {
      console.error("❌ Error loading main-text.md:", error);
      currentLazyLoader.container.innerHTML =
        "<p>Unable to load content. Please refresh the page.</p>";
    }
    return;
  }

  console.log(`🎯 Found target position: ${targetId}. Navigating...`);

  // Delegate to the navigation function (don't show overlay if already shown)
  navigateToInternalId(targetId, currentLazyLoader, !overlayShown);
}

function scrollElementIntoContainer(
  targetElement,
  contentContainer, // This is currentLazyLoader.container, which is your <div class="main-content" id="book">
  headerOffset = 0
) {
  if (!contentContainer) { // Changed 'container' to 'contentContainer'
    console.error(
      "Content container not available, falling back to default scrollIntoView"
    );
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  // >>>>>> THIS IS THE CRUCIAL NEW PART <<<<<<
  // Find the actual scrollable parent (e.g., .reader-content-wrapper)
  const scrollableParent = contentContainer.closest(".reader-content-wrapper") ||
                           contentContainer.closest(".home-content-wrapper");

  if (!scrollableParent) {
    console.error("ERROR: No scrollable parent wrapper found for content container!");
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  // >>>>>> END CRUCIAL NEW PART <<<<<<

  // 🎯 USE CONSISTENT SCROLL METHOD
  const targetScrollTop = scrollElementWithConsistentMethod(targetElement, scrollableParent, 192);
  
  // 🚨 INTERFERENCE DETECTION: Monitor for scroll position changes
  let interferenceDetected = false;
  const monitorScrollInterference = () => {
    if (interferenceDetected) return;
    const currentPos = scrollableParent.scrollTop;
    if (Math.abs(currentPos - targetScrollTop) > 5) { // Allow 5px tolerance
      interferenceDetected = true;
      console.log(`🚨 SCROLL INTERFERENCE DETECTED! Position changed from ${targetScrollTop} to ${currentPos} (diff: ${Math.abs(currentPos - targetScrollTop)}px)`);
      console.trace("Interference source trace:");
    }
  };
  
  // Monitor for 2 seconds after navigation
  const monitorInterval = setInterval(monitorScrollInterference, 100);
  setTimeout(() => clearInterval(monitorInterval), 2000);
  
  // Verify after a short delay with detailed debugging
  setTimeout(() => {
    // Skip verification and correction if user started scrolling
    if (shouldSkipScrollRestoration("scroll verification")) {
      return;
    }
    
    const verifyElementRect = targetElement.getBoundingClientRect();
    const verifyScrollableRect = scrollableParent.getBoundingClientRect();
    const finalElementPosition = verifyElementRect.top - verifyScrollableRect.top;
    const actualScrollTop = scrollableParent.scrollTop;
    
    console.log(`🔍 DETAILED VERIFICATION AFTER SCROLL:`);
    console.log(`  📍 Scroll Position:`);
    console.log(`    - Expected: ${targetScrollTop}`);
    console.log(`    - Actual: ${actualScrollTop}`);
    console.log(`    - Precision loss: ${Math.abs(actualScrollTop - targetScrollTop)}px`);
    console.log(`  📍 Element Positioning:`);
    console.log(`    - Element getBoundingClientRect().top: ${verifyElementRect.top}`);
    console.log(`    - Container getBoundingClientRect().top: ${verifyScrollableRect.top}`);
    console.log(`    - Calculated position: ${finalElementPosition}px from container top`);
    console.log(`    - Target position: 192px from container top`);
    console.log(`    - Position error: ${Math.abs(finalElementPosition - 192)}px`);
    console.log(`  📍 Element Properties:`);
    console.log(`    - offsetTop: ${targetElement.offsetTop}`);
    console.log(`    - offsetParent: ${targetElement.offsetParent?.tagName}#${targetElement.offsetParent?.id}`);
    console.log(`  📍 Container Properties:`);
    console.log(`    - scrollTop: ${scrollableParent.scrollTop}`);
    console.log(`    - clientHeight: ${scrollableParent.clientHeight}`);
    console.log(`    - scrollHeight: ${scrollableParent.scrollHeight}`);
    console.log(`  🎯 Success: ${Math.abs(finalElementPosition - 192) < 50 ? '✅' : '❌'}`);
    
    // 🚨 ATTEMPT AUTO-CORRECTION if position is significantly off
    if (Math.abs(finalElementPosition - 192) > 50) {
      console.log(`🔧 AUTO-CORRECTION: Position is ${Math.abs(finalElementPosition - 192)}px off, attempting correction`);
      const correctionNeeded = finalElementPosition - 192; // How far off we are
      const correctedScrollTop = actualScrollTop + correctionNeeded;
      console.log(`🔧 Applying correction: ${correctionNeeded}px (new scroll: ${correctedScrollTop})`);
      
      scrollableParent.scrollTo({
        top: correctedScrollTop,
        behavior: "instant"
      });
      
      // Verify correction
      setTimeout(() => {
        const correctedElementRect = targetElement.getBoundingClientRect();
        const correctedPosition = correctedElementRect.top - verifyScrollableRect.top;
        console.log(`🔧 CORRECTION RESULT: Element now at ${correctedPosition}px from top`);
      }, 50);
    }
  }, 100);
  
  return; // Exit early, skip the rest of the function
  
  console.log(`🔍 OFFSET CALCULATION: element.offsetTop=${targetElement.offsetTop}, total calculated=${elementOffsetTop}`);
  console.log(`🔍 CONTAINER HIERARCHY DEBUG:`);
  console.log(`  - content container (${contentContainer.tagName}#${contentContainer.id}): offsetTop=${contentContainer.offsetTop}, offsetParent=${contentContainer.offsetParent?.tagName || 'null'}`);
  console.log(`  - scrollable parent (${scrollableParent.tagName}.${scrollableParent.className}): offsetTop=${scrollableParent.offsetTop}`);
  console.log(`  - target element offsetParent: ${targetElement.offsetParent?.tagName}#${targetElement.offsetParent?.id || 'no-id'}`);
  
  // Let's also check CSS computed styles for any transforms/positioning
  const contentStyles = window.getComputedStyle(contentContainer);
  const scrollStyles = window.getComputedStyle(scrollableParent);
  console.log(`  - content container padding-top: ${contentStyles.paddingTop}, margin-top: ${contentStyles.marginTop}`);
  console.log(`  - scrollable parent padding-top: ${scrollStyles.paddingTop}, margin-top: ${scrollStyles.marginTop}`);
  
  // Position element at ideal position from top of visible container
  const containerVisibleHeight = scrollableParent.clientHeight;
  const idealPositionFromTop = Math.min(containerVisibleHeight / 3, 192); // Top third, max 192px
  
  // We already calculated targetScrollTop above using native scrollIntoView + adjustment
  console.log(`🔍 USING CALCULATED TARGET SCROLL: ${targetScrollTop}`);
  
  console.log(`📐 Container height: ${containerVisibleHeight}px, ideal position: ${idealPositionFromTop}px from top`);
  console.log(`📍 Content container offsetTop: ${contentContainer.offsetTop}`);
  console.log(`📍 Current scroll: ${scrollableParent.scrollTop}, calculated element offset: ${elementOffsetTop}`);
  console.log("Scrolling the actual container:", scrollableParent.id || scrollableParent.className);
  console.log("Calculated targetScrollTop:", targetScrollTop);

  // >>>>>> THIS IS THE FINAL CRUCIAL CHANGE <<<<<<
  // Tell the *actual scrollable parent* to scroll
  console.log(`📜 Attempting to scroll to: ${targetScrollTop} (current scrollTop: ${scrollableParent.scrollTop})`);
  
  scrollableParent.scrollTo({
    top: targetScrollTop,
    behavior: "smooth"
  });
  
  // Enhanced verification with detailed debugging
  setTimeout(() => {
    const actualScrollTop = scrollableParent.scrollTop;
    console.log(`📜 After scroll attempt - scrollTop is now: ${actualScrollTop}`);
    
    // Get fresh positioning info after scroll
    const elementRect = targetElement.getBoundingClientRect();
    const scrollableRect = scrollableParent.getBoundingClientRect();
    
    // Calculate where the element actually appears relative to the container
    const actualElementPositionFromTop = elementRect.top - scrollableRect.top;
    console.log(`🔍 DEBUGGING - After scroll:`);
    console.log(`  - Target scroll position: ${targetScrollTop}`);
    console.log(`  - Actual scroll position: ${actualScrollTop}`);
    console.log(`  - Element getBoundingClientRect().top: ${elementRect.top}`);
    console.log(`  - Container getBoundingClientRect().top: ${scrollableRect.top}`);
    console.log(`  - Element position from container top: ${actualElementPositionFromTop}px`);
    console.log(`  - Expected position from container top: ${idealPositionFromTop}px`);
    
    const positionError = Math.abs(actualElementPositionFromTop - idealPositionFromTop);
    console.log(`  - Position error: ${positionError}px`);
    
    // Check if element is visible in viewport
    const isVisible = elementRect.top >= scrollableRect.top && 
                      elementRect.bottom <= scrollableRect.bottom &&
                      elementRect.left >= scrollableRect.left && 
                      elementRect.right <= scrollableRect.right;
    
    console.log(`📍 Element visibility: ${isVisible ? '✅ VISIBLE' : '❌ NOT VISIBLE'}`);
    
    if (!isVisible || positionError > 100) {
      console.warn(`⚠️ Element positioning failed - using fallback scrollIntoView`);
      targetElement.scrollIntoView({ 
        behavior: "smooth", 
        block: "start", 
        inline: "nearest" 
      });
    }
  }, 500);
  // >>>>>> END FINAL CRUCIAL CHANGE <<<<<<
}
// Navigation loading indicator with overlay and progress bar
let navigationModal = null;

export function showNavigationLoading(targetId) {
  console.log(`🎯 LOADING: Starting navigation to ${targetId}`);
  
  // Store in sessionStorage so overlay persists across page transitions
  sessionStorage.setItem('navigationOverlayActive', 'true');
  sessionStorage.setItem('navigationTargetId', targetId);
  
  // Try to use existing blade template overlay first
  const initialOverlay = document.getElementById('initial-navigation-overlay');
  if (initialOverlay) {
    navigationModal = initialOverlay;
    navigationModal.style.display = 'block';
  } else {
    // Fallback: create overlay if blade template overlay doesn't exist
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

    const loadedChunksPromises = chunksToLoad.map(chunkId => {
      return new Promise((resolve) => {
        lazyLoader.loadChunk(chunkId, "down");
        resolve();
      });
    });
    
    await Promise.all(loadedChunksPromises);
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
      const fallbackTarget = lazyLoader.container.querySelector(`#${CSS.escape(targetId)}`);
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
    
    // 🎯 FINAL SCROLL - No more corrections, no more delays
    console.log(`🎯 FINAL SCROLL: Navigating to confirmed ready element: ${targetId}`);
    const scrollableParent = lazyLoader.scrollableParent;
    
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
    
    // For highlights, open them after scrolling starts
    if (targetId.startsWith('HL_')) {
      setTimeout(() => {
        console.log(`Opening highlight after navigation: ${targetId}`);
        openHighlightById(targetId);
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
    const elementRect = targetElement.getBoundingClientRect();
    const containerRect = scrollableParent.getBoundingClientRect();
    const currentPosition = elementRect.top - containerRect.top;
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
      
      // 🧹 Clear hypercite hash from URL after successful navigation
      if (targetId && (targetId.startsWith('hypercite_') || targetId.startsWith('HL_'))) {
        console.log(`🧹 Clearing hypercite hash from URL: #${targetId}`);
        const currentPath = window.location.pathname + window.location.search;
        window.history.replaceState(null, document.title, currentPath);
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
