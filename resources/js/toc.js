// toc.js

// Import your helper functions and container manager.
import { getNodeChunksFromIndexedDB } from "./cache-indexedDB.js";
import { book } from "./app.js";
import { navigateToInternalId, showNavigationLoading } from "./scrolling.js"; // your internal navigation function
import { ContainerManager } from "./container-manager.js";
import { currentLazyLoader } from "./initializePage.js";

// Get DOM elements for TOC container, overlay, and toggle button.
export const tocContainer = document.getElementById("toc-container");
export const tocOverlay = document.getElementById("toc-overlay");
export const tocButton = document.getElementById("toc-toggle-button");

// Create a custom TOC manager that generates content before opening
class TocContainerManager extends ContainerManager {
  async openContainer() {
    console.log("📋 TOC opening - generating content first...");
    await generateTableOfContents(); // Generate TOC content before opening
    super.openContainer(); // Then open the container
  }
}

// Create a container manager instance for the TOC.  
// Only freeze main-content, keep nav buttons visible like highlights
const tocManager = new TocContainerManager(
  "toc-container",
  "toc-overlay",
  "toc-toggle-button",
  ["main-content"]
);

// TOC cache management
let tocCache = {
  data: null,
  lastScanTime: 0,
  bookId: null,
  headingCount: 0
};

/**
 * Check if TOC cache is valid for the current book
 */
function isTocCacheValid() {
  const isValid = (
    tocCache.data !== null &&
    tocCache.bookId === book &&
    Date.now() - tocCache.lastScanTime < 30000 // 30 second cache
  );
  
  console.log(`📋 TOC Cache check:`, {
    hasData: tocCache.data !== null,
    correctBook: tocCache.bookId === book,
    timeValid: Date.now() - tocCache.lastScanTime < 30000,
    lastScan: new Date(tocCache.lastScanTime).toLocaleTimeString(),
    isValid
  });
  
  return isValid;
}

/**
 * Scan nodeChunks content for heading elements
 */
async function scanForHeadings() {
  console.log("📖 Scanning nodeChunks for headings...");
  
  let nodeChunks = [];
  try {
    nodeChunks = await getNodeChunksFromIndexedDB(book);
  } catch (e) {
    console.error("Error retrieving nodeChunks from IndexedDB:", e);
    return [];
  }

  const headings = [];
  const headingRegex = /^<(h[1-6])[^>]*id="([^"]+)"[^>]*>(.*?)<\/h[1-6]>/i;

  for (const chunk of nodeChunks) {
    if (!chunk.content) continue;
    
    const match = chunk.content.match(headingRegex);
    if (match) {
      const [, tagName, id, textContent] = match;
      
      // Clean up the text content (remove any nested HTML tags)
      const cleanText = textContent.replace(/<[^>]*>/g, '').trim();
      
      if (cleanText) {
        headings.push({
          id,
          type: tagName.toLowerCase(),
          text: cleanText,
          link: `#${id}`,
        });
      }
    }
  }

  console.log(`📖 Found ${headings.length} headings`);
  return headings.sort((a, b) => {
    // Sort by numerical ID if possible, otherwise alphabetically
    const aNum = parseFloat(a.id);
    const bNum = parseFloat(b.id);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      return aNum - bNum;
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Generates the Table of Contents with caching.
 * @param {string} containerIdLegacy - Legacy parameter for backward compatibility (ignored)
 * @param {string} buttonIdLegacy - Legacy parameter for backward compatibility (ignored)
 */
export async function generateTableOfContents(containerIdLegacy, buttonIdLegacy) {
  console.log("📋 generateTableOfContents called");
  
  if (!tocContainer) {
    console.error("TOC container not found!");
    return;
  }

  // Check if we can use cached data
  if (isTocCacheValid()) {
    console.log("📋 Using cached TOC data");
    renderTOC(tocContainer, tocCache.data);
    attachTocClickHandler();
    return;
  }

  // Scan for headings and cache the results
  console.log("📋 Cache invalid, scanning for headings...");
  const tocData = await scanForHeadings();
  
  // Update cache
  tocCache = {
    data: tocData,
    lastScanTime: Date.now(),
    bookId: book,
    headingCount: tocData.length
  };

  console.log("📋 Cache updated, rendering TOC");
  // Render the TOC
  renderTOC(tocContainer, tocData);
  attachTocClickHandler();
}

/**
 * Attach click handler for TOC navigation (separated for reuse)
 */
function attachTocClickHandler() {
  // Remove existing listeners to avoid duplicates
  const existingHandler = tocContainer._tocClickHandler;
  if (existingHandler) {
    tocContainer.removeEventListener("click", existingHandler);
  }

  // Add new click handler
  const clickHandler = (event) => {
    const link = event.target.closest("a");
    if (link) {
      event.preventDefault();
      const targetId = link.hash.substring(1);
      if (!targetId) return;
      
      showNavigationLoading(targetId);
      tocManager.closeContainer();
      console.log(`📌 Navigating via TOC to: ${targetId}`);
      navigateToInternalId(targetId, currentLazyLoader, false);
    }
  };

  tocContainer.addEventListener("click", clickHandler);
  tocContainer._tocClickHandler = clickHandler;
}

/**
 * Renders the TOC data into a container.
 *
 * The TOC will be rendered as a series of <a> elements wrapping the appropriate heading tag.
 *
 * @param {HTMLElement} container - The container element in which to render the TOC.
 * @param {Array<Object>} tocData - The TOC data array.
 */
export function renderTOC(container, tocData) {
  // Clear any existing content.
  container.innerHTML = "";

  // Create a wrapper for the scrollable content.
  const scroller = document.createElement("div");
  scroller.classList.add("scroller");

  // Create the TOC entries inside the scroller.
  tocData.forEach((item, index) => {
    const anchor = document.createElement("a");
    anchor.href = item.link;

    const heading = document.createElement(item.type);
    heading.textContent = item.text;

    // If this is the first heading, add the "first" class.
    if (index === 0) {
      heading.classList.add("first");
    }

    anchor.appendChild(heading);
    scroller.appendChild(anchor);
  });

  // Insert the scrollable container into the main container.
  container.appendChild(scroller);

  // Create the top mask.
  const maskTop = document.createElement("div");
  maskTop.classList.add("mask-top");

  // Create the bottom mask.
  const maskBottom = document.createElement("div");
  maskBottom.classList.add("mask-bottom");

  // Append the masks to the container.
  container.appendChild(maskTop);
  container.appendChild(maskBottom);
}




/**
 * Opens the TOC using the container manager.
 */
export function openTOC() {
  tocManager.openContainer();
}

/**
 * Closes the TOC using the container manager.
 */
export function closeTOC() {
  tocManager.closeContainer();
}

/**
 * Toggles the TOC using the container manager.
 */
export function toggleTOC() {
  tocManager.toggleContainer();
}

/**
 * Invalidate TOC cache - forces a rescan on next access
 */
export function invalidateTocCache() {
  console.log("🔄 TOC cache invalidated - STACK TRACE:", new Error().stack);
  tocCache.data = null;
  tocCache.lastScanTime = 0;
}

/**
 * Check if a node change affects headings and invalidate cache if needed
 */
export function checkAndInvalidateTocCache(nodeId, nodeElement) {
  if (!nodeElement) return false;
  
  // Check if this is a heading element
  const isHeading = /^h[1-6]$/i.test(nodeElement.tagName);
  
  if (isHeading) {
    console.log(`🔄 Heading ${nodeId} changed, invalidating TOC cache`);
    invalidateTocCache();
    return true;
  }
  
  return false;
}

/**
 * Force invalidate cache for any node deletion (safer approach)
 */
export function invalidateTocCacheForDeletion(nodeId) {
  console.log(`🔄 Node ${nodeId} deleted, invalidating TOC cache (safe approach)`);
  invalidateTocCache();
}

/**
 * Force immediate TOC refresh (bypasses cache)
 */
export async function refreshTOC() {
  invalidateTocCache();
  await generateTableOfContents();
}
