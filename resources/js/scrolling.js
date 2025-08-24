// In scrolling.js

import { book, OpenHyperlightID } from "./app.js";
import { openHighlightById } from './hyperLights.js';
import {
  getNodeChunksFromIndexedDB,
  getLocalStorageKey
} from "./cache-indexedDB.js";
import { parseMarkdownIntoChunksInitial } from "./convert-markdown.js";
import { currentLazyLoader } from "./initializePage.js";
import { repositionSentinels } from "./lazyLoaderFactory.js"; // if exported
import { 
  waitForNavigationTarget, 
  waitForElementReady, 
  waitForChunkLoadingComplete 
} from "./domReadiness.js";

// ========= Scrolling Helper Functions =========

export function scrollElementIntoMainContent(targetElement, headerOffset = 0) {
  // `book` is the ID of your <div class="main-content">
  const contentContainer = document.getElementById(book); // Renamed `container` to `contentContainer` for clarity
  if (!contentContainer) { // Changed 'container' to 'contentContainer'
    console.error(`Content container with id ${book} not found!`);
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  // >>>>>> THIS IS THE CRUCIAL NEW PART <<<<<<
  // Find the actual scrollable parent (e.g., .reader-content-wrapper)
  const scrollableParent = contentContainer.closest(".reader-content-wrapper") ||
                           contentContainer.closest(".home-content-wrapper"); // Keep both for home page too

  if (!scrollableParent) {
    console.error("ERROR: No scrollable parent wrapper found for content container!");
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  // >>>>>> END CRUCIAL NEW PART <<<<<<

  // 🚀 FINAL FIX: Calculate element's absolute position within the scrollable document
  let elementOffsetTop = targetElement.offsetTop;
  let offsetParent = targetElement.offsetParent;
  
  // Walk up the chain until we reach the content container or scrollable parent
  while (offsetParent && offsetParent !== contentContainer && offsetParent !== scrollableParent) {
    elementOffsetTop += offsetParent.offsetTop;
    offsetParent = offsetParent.offsetParent;
  }
  
  // If we reached the content container, add its position relative to scrollable parent
  if (offsetParent === contentContainer) {
    elementOffsetTop += contentContainer.offsetTop;
  }
  
  const targetScrollTop = Math.max(0, elementOffsetTop - headerOffset);

  console.log(`📍 Element offsetTop: ${targetElement.offsetTop}, calculated total: ${elementOffsetTop}`);
  console.log(`📍 Target scroll: ${targetScrollTop}, header offset: ${headerOffset}`);
  console.log("Scrollable parent container:", scrollableParent.className);

  // >>>>>> THIS IS THE FINAL CRUCIAL CHANGE <<<<<<
  // Tell the *actual scrollable parent* to scroll
  scrollableParent.scrollTo({
    top: targetScrollTop,
    behavior: "smooth"
  });
  // >>>>>> END FINAL CRUCIAL CHANGE <<<<<<
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

  // Delegate to the navigation function.
  navigateToInternalId(targetId, currentLazyLoader);
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

  // 🚀 FINAL FIX: Calculate element's absolute position within the scrollable document
  // We need the element's true position within the scrollable content, not its current screen position
  
  // Method 1: Try using offsetTop with proper container walking
  let elementOffsetTop = targetElement.offsetTop;
  let offsetParent = targetElement.offsetParent;
  
  // Walk up the chain until we reach the content container or scrollable parent
  while (offsetParent && offsetParent !== contentContainer && offsetParent !== scrollableParent) {
    elementOffsetTop += offsetParent.offsetTop;
    offsetParent = offsetParent.offsetParent;
  }
  
  // If we reached the content container, add its position relative to scrollable parent
  if (offsetParent === contentContainer) {
    elementOffsetTop += contentContainer.offsetTop;
  }
  
  console.log(`🔍 OFFSET CALCULATION: element.offsetTop=${targetElement.offsetTop}, total calculated=${elementOffsetTop}`);
  
  // Position element at ideal position from top of visible container
  const containerVisibleHeight = scrollableParent.clientHeight;
  const idealPositionFromTop = Math.min(containerVisibleHeight / 3, 192); // Top third, max 192px
  
  // Calculate scroll position so the element appears at idealPositionFromTop
  // If we scroll to (elementOffsetTop - idealPositionFromTop), then the element 
  // will appear at idealPositionFromTop pixels from the container's visible top
  const targetScrollTop = Math.max(0, elementOffsetTop - idealPositionFromTop);
  
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
export function navigateToInternalId(targetId, lazyLoader) {
  if (!lazyLoader) {
    console.error("Lazy loader instance not provided!");
    return;
  }
  console.log("Initiating navigation to internal ID:", targetId);
  
  // 🚀 FIX: Clear session storage when explicitly navigating to prevent cached position interference
  if (targetId && targetId.trim() !== '') {
    const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
    console.log(`🧹 Clearing session scroll cache for explicit navigation to: ${targetId}`);
    sessionStorage.removeItem(scrollKey);
  }
  
  _navigateToInternalId(targetId, lazyLoader);
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

async function _navigateToInternalId(targetId, lazyLoader) {
  // Check if the target element is already present and fully rendered
  let existingElement = lazyLoader.container.querySelector(
    `#${CSS.escape(targetId)}`
  );
  
  if (existingElement) {
    try {
      // 🚀 NEW: Verify the element is actually ready before proceeding
      console.log(`📍 Found existing element ${targetId}, verifying readiness...`);
      
      const readyElement = await waitForElementReady(targetId, {
        maxAttempts: 5, // Quick check since element exists
        checkInterval: 20,
        container: lazyLoader.container
      });
      
      console.log(`✅ Existing element ${targetId} confirmed ready`);
      
      // Scroll immediately since element is confirmed ready
      console.log(`📍 Scrolling to existing element: ${targetId}`);
      const scrollableParent = lazyLoader.scrollableParent;
      
      if (scrollableParent && scrollableParent !== window) {
        console.log(`📍 Using custom scroll for existing element in container: ${scrollableParent.className}`);
        scrollElementIntoContainer(readyElement, lazyLoader.container, 150);
      } else {
        console.log(`📍 Using native scrollIntoView for existing element`);
        readyElement.scrollIntoView({ 
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
      lazyLoader.isNavigatingToInternalId = false;
      return;
      
    } catch (error) {
      console.warn(`⚠️ Existing element ${targetId} not fully ready: ${error.message}. Proceeding with chunk loading...`);
      // Continue to chunk loading logic below
    }
  }

  // Otherwise, determine which chunk should contain the target.
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
    fallbackScrollPosition(lazyLoader);
    if (typeof lazyLoader.attachMarkListeners === "function") {
      lazyLoader.attachMarkListeners(lazyLoader.container);
    }
    lazyLoader.isNavigatingToInternalId = false;
    return;
  }

  // Clear the container and load the chunk (plus adjacent chunks).
  lazyLoader.container.innerHTML = "";
  lazyLoader.currentlyLoadedChunks.clear();
  
  // 🚀 FIX: Get the actual chunk_id of the target node, not array index
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

  const loadedChunksPromises = chunksToLoad.map(chunkId => {
    return new Promise((resolve) => {
      lazyLoader.loadChunk(chunkId, "down");
      resolve();
    });
  });
  
  Promise.all(loadedChunksPromises)
    .then(async () => {
      lazyLoader.repositionSentinels();
      
      try {
        // 🚀 NEW: Use DOM readiness detection instead of fixed timeout
        console.log(`🎯 Waiting for navigation target to be ready: ${targetId}`);
        
        const finalTarget = await waitForNavigationTarget(
          targetId, 
          lazyLoader.container,
          targetChunkId, // 🚀 NOW we know the exact chunk ID!
          { 
            maxWaitTime: 5000, // 5 second max wait
            requireVisible: false 
          }
        );
        
        console.log(`✅ Navigation target ready: ${targetId}`);
        
        // Scroll to the target immediately since it's confirmed ready
        console.log(`🎯 About to scroll to confirmed ready element: ${targetId}`);
        
        // 🚀 Fix: Use scrollIntoView with the correct scrollable container
        console.log(`📍 Using scrollIntoView for element: ${targetId}`);
        const scrollableParent = lazyLoader.scrollableParent;
        
        if (scrollableParent && scrollableParent !== window) {
          // For custom containers, we need to use our custom scroll method
          console.log(`📍 Using custom scroll for container: ${scrollableParent.className}`);
          scrollElementIntoContainer(finalTarget, lazyLoader.container, 150);
        } else {
          // For window scrolling, use native method
          console.log(`📍 Using native scrollIntoView for window scrolling`);
          finalTarget.scrollIntoView({ 
            behavior: "smooth", 
            block: "start", 
            inline: "nearest" 
          });
        }
        
        // For highlights, open them after scrolling
        if (targetId.startsWith('HL_')) {
          // Small delay to let scroll animation start
          setTimeout(() => {
            console.log(`Opening highlight after navigation: ${targetId}`);
            openHighlightById(targetId);
          }, 200);
        }
        
        // Clean up navigation state
        if (typeof lazyLoader.attachMarkListeners === "function") {
          lazyLoader.attachMarkListeners(lazyLoader.container);
        }
        lazyLoader.isNavigatingToInternalId = false;
        
      } catch (error) {
        console.warn(
          `❌ Failed to wait for target element ${targetId}: ${error.message}. ` +
            "Using fallback scroll position."
        );
        
        // Fallback: try once more with querySelector in case it's there but not detected
        const fallbackTarget = lazyLoader.container.querySelector(`#${CSS.escape(targetId)}`);
        if (fallbackTarget) {
          console.log(`📍 Found target on fallback attempt: ${targetId}`);
          const scrollableParent = lazyLoader.scrollableParent;
          
          if (scrollableParent && scrollableParent !== window) {
            console.log(`📍 Using custom scroll for fallback element in container: ${scrollableParent.className}`);
            scrollElementIntoContainer(fallbackTarget, lazyLoader.container, 150);
          } else {
            console.log(`📍 Using native scrollIntoView for fallback element`);
            fallbackTarget.scrollIntoView({ 
              behavior: "smooth", 
              block: "start", 
              inline: "nearest" 
            });
          }
          
          if (targetId.startsWith('HL_')) {
            setTimeout(() => {
              openHighlightById(targetId);
            }, 200);
          }
        } else {
          // Last resort: use existing fallback
          fallbackScrollPosition(lazyLoader);
        }
        
        if (typeof lazyLoader.attachMarkListeners === "function") {
          lazyLoader.attachMarkListeners(lazyLoader.container);
        }
        lazyLoader.isNavigatingToInternalId = false;
      }
    })
    .catch(error => {
      console.error("Error while loading chunks:", error);
      lazyLoader.isNavigatingToInternalId = false;
    });
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
