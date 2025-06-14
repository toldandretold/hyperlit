// In scrolling.js

import { book, OpenHyperlightID } from "./app.js";
import { openHighlightById } from './hyperLights.js';
import {
  getNodeChunksFromIndexedDB,
  getLocalStorageKey
} from "./cache-indexedDB.js";
import { parseMarkdownIntoChunksInitial } from "./convert-markdown.js";
import { injectFootnotesForChunk } from "./footnotes.js";
import { currentLazyLoader } from "./initializePage.js";
import { repositionSentinels } from "./lazyLoaderFactory.js"; // if exported

// ========= Scrolling Helper Functions =========

function scrollElementIntoMainContent(targetElement, headerOffset = 0) {
  const container = document.getElementById(book);
  if (!container) {
    console.error(`Container with id ${book} not found!`);
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const offset = elementRect.top - containerRect.top + container.scrollTop;
  const targetScrollTop = offset - headerOffset;
  console.log("Element rect:", elementRect);
  console.log("Container rect:", containerRect);
  console.log("Container current scrollTop:", container.scrollTop);
  console.log("Calculated targetScrollTop:", targetScrollTop);
  container.scrollTo({
    top: targetScrollTop,
    behavior: "smooth"
  });
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

  try {
    const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
    const sessionSavedId = sessionStorage.getItem(scrollKey);
    if (sessionSavedId && sessionSavedId !== "0") {
      const parsed = JSON.parse(sessionSavedId);
      if (parsed && parsed.elementId) {
        // only override if we have a valid target from storage and
        // if the hash target doesn't exist in the document.
        targetId = parsed.elementId;
      }
    }
  } catch (e) {
    console.log("⚠️ sessionStorage not available or parse error", e);
  }
  
  try {
    const scrollKey = getLocalStorageKey("scrollPosition", currentLazyLoader.bookId);
    const localSavedId = localStorage.getItem(scrollKey);
    if (localSavedId && localSavedId !== "0") {
      const parsed = JSON.parse(localSavedId);
      if (parsed && parsed.elementId) {
        targetId = parsed.elementId;
      }
    }
  } catch (e) {
    console.log("⚠️ localStorage not available or parse error", e);
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
  container,
  headerOffset = 0
) {
  if (!container) {
    console.error(
      "Container not available, falling back to default scrollIntoView"
    );
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const offset = elementRect.top - containerRect.top + container.scrollTop;
  const targetScrollTop = offset - headerOffset;
  console.log("Scrolling container:", container.id);
  console.log("Element rect:", elementRect);
  console.log("Container rect:", containerRect);
  console.log("Calculated targetScrollTop:", targetScrollTop);
  container.scrollTo({
    top: targetScrollTop,
    behavior: "smooth"
  });
}

export function navigateToInternalId(targetId, lazyLoader) {
  if (!lazyLoader) {
    console.error("Lazy loader instance not provided!");
    return;
  }
  console.log("Initiating navigation to internal ID:", targetId);
  _navigateToInternalId(targetId, lazyLoader);
}

function _navigateToInternalId(targetId, lazyLoader) {
  // Check if the target element is already present.
  let existingElement = lazyLoader.container.querySelector(
    `#${CSS.escape(targetId)}`
  );
  if (existingElement) {
    // Already available: scroll and highlight.
    scrollElementIntoContainer(existingElement, lazyLoader.container, 50);
    
    // Check if this is a highlight ID (starts with HL_)
   if (targetId.startsWith('HL_')) {
    // Check if the highlight element is already visible
    const highlightElement = lazyLoader.container.querySelector(`#${CSS.escape(targetId)}`);
    
    let delay = 100; // Default short delay
    
    if (highlightElement) {
      // Check if element is in viewport
      const rect = highlightElement.getBoundingClientRect();
      const containerRect = lazyLoader.container.getBoundingClientRect();
      
      const isVisible = (
        rect.top >= containerRect.top &&
        rect.bottom <= containerRect.bottom &&
        rect.left >= containerRect.left &&
        rect.right <= containerRect.right
      );
      
      if (!isVisible) {
        // Element exists but not visible - needs scrolling
        delay = 400;
        console.log(`Highlight ${targetId} needs scrolling, using ${delay}ms delay`);
      } else {
        // Element is already visible - minimal delay
        delay = 100;
        console.log(`Highlight ${targetId} already visible, using ${delay}ms delay`);
      }
    } else {
      // Element doesn't exist yet - will need loading and scrolling
      delay = 800;
      console.log(`Highlight ${targetId} not loaded yet, using ${delay}ms delay`);
    }
    
    setTimeout(() => {
      console.log(`Opening highlight after navigation: ${targetId}`);
      openHighlightById(targetId);
    }, delay);
  }


    setTimeout(() => {
      if (typeof lazyLoader.attachMarkListeners === "function") {
        lazyLoader.attachMarkListeners(lazyLoader.container);
      }
      lazyLoader.isNavigatingToInternalId = false;
    }, 400);
    return;
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
  const startIndex = Math.max(0, targetChunkIndex - 1);
  const endIndex = Math.min(
    lazyLoader.nodeChunks.length - 1,
    targetChunkIndex + 1
  );
  console.log(`Loading chunks ${startIndex} to ${endIndex}`);

  const loadedChunksPromises = Array.from(
    { length: endIndex - startIndex + 1 },
    (_, i) => {
      const node = lazyLoader.nodeChunks[startIndex + i];
      return new Promise((resolve) => {
        lazyLoader.loadChunk(node.chunk_id, "down");
        resolve();
      });
    }
  );
  Promise.all(loadedChunksPromises)
  .then(() => {
    // Optionally inject footnotes for each node.
    for (let i = startIndex; i <= endIndex; i++) {
      const node = lazyLoader.nodeChunks[i];
      injectFootnotesForChunk(node.chunk_id, book);
    }
    lazyLoader.repositionSentinels();
    // Delay a bit to let DOM updates settle.
    setTimeout(() => {
      let finalTarget = lazyLoader.container.querySelector(
        `#${CSS.escape(targetId)}`
      );
      if (finalTarget) {
        scrollElementIntoContainer(finalTarget, lazyLoader.container, 50);
              
        // Check if this is a highlight ID (starts with HL_)
        if (targetId.startsWith('HL_')) {
          // Wait a moment for the scroll to complete, then open the highlight
          setTimeout(() => {
            console.log(`Opening highlight after navigation: ${targetId}`);
            openHighlightById(targetId);
          }, 800);
        }
      } else {
        console.warn(
          `Target element ${targetId} not found after loading chunks. ` +
            "Using fallback scroll position."
        );
        fallbackScrollPosition(lazyLoader);
      }
      if (typeof lazyLoader.attachMarkListeners === "function") {
        lazyLoader.attachMarkListeners(lazyLoader.container);
      }
      lazyLoader.isNavigatingToInternalId = false;
    }, 400);
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
