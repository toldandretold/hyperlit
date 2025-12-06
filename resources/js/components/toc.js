// toc.js

// Import your helper functions and container manager.
import { getNodeChunksFromIndexedDB, getLocalStorageKey } from "../indexedDB/index.js";
import { book } from "../app.js";
import { navigateToInternalId, showNavigationLoading } from "../scrolling.js"; // your internal navigation function
import { ContainerManager } from "../containerManager.js";
import { currentLazyLoader } from "../initializePage.js";
import { log, verbose } from "../utilities/logger.js";

// Get DOM elements for TOC container, overlay, and toggle button.
export const tocContainer = document.getElementById("toc-container");
export const tocOverlay = document.getElementById("toc-overlay");
export const tocButton = document.getElementById("toc-toggle-button");

// Create a custom TOC manager that generates content before opening
let tocManager = null;

class TocContainerManager extends ContainerManager {
  async openContainer() {
    // First, render the TOC with preserved masks.
    await generateTableOfContents(); 
    
    // DEBUG: Log what initialContent contains
    console.log('🚨 INITIAL CONTENT:', this.initialContent);
    console.log('🚨 CONTAINER BEFORE OPEN:', this.container.innerHTML.substring(0, 300));
    
    // Masks are now fully styled in HTML - no JavaScript manipulation needed
    
    // Prepare container for opening but keep it hidden until fully ready
    if (window.containerCustomizer) window.containerCustomizer.loadCustomizations();
    
    // Set up all state BEFORE making container visible

    this.isOpen = true;
    window.activeContainer = this.container.id;

    if (this.container.id === "toc-container") {
      this.saveNavElementsState();
    }

    this.updateState();
    
    // Add bookmark and set scroll position BEFORE showing container
    updateOrInsertBookmark(this.container, tocCache.data);
    setInitialBookmarkPosition(this.container);
    
    // NOW make container visible with open class applied immediately
    this.container.classList.remove("hidden");
    this.container.classList.add("open");
    
    // Only focus the container if it's not a back button navigation
    if (!this.isBackNavigation) {
      this.container.focus();
    }

  }
}

export function initializeTocManager() {
  if (!document.getElementById("toc-toggle-button")) {
    return;
  }

  if (!tocManager) {
    tocManager = new TocContainerManager(
      "toc-container",
      "toc-overlay",
      "toc-toggle-button",
      ["main-content"]
    );
    log.init('TOC Manager initialized', '/components/toc.js');
  } else {
    tocManager.rebindElements();
  }
}

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
  const currentBook = book;
  const isValid = (
    tocCache.data !== null &&
    tocCache.bookId === currentBook &&
    Date.now() - tocCache.lastScanTime < 30000 // 30 second cache
  );
  
  console.log(`📋 TOC Cache check:`, {
    hasData: tocCache.data !== null,
    correctBook: tocCache.bookId === currentBook,
    timeValid: Date.now() - tocCache.lastScanTime < 30000,
    lastScan: new Date(tocCache.lastScanTime).toLocaleTimeString(),
    isValid
  });
  
  return isValid;
}

/**
 * Scan nodes content for heading elements
 */
async function scanForHeadings() {
  console.log("📖 Scanning nodes for headings...");
  
  let nodes = [];
  try {
    nodes = await getNodeChunksFromIndexedDB(book);
  } catch (e) {
    console.error("Error retrieving nodes from IndexedDB:", e);
    return [];
  }

  const headings = [];
  // Match id="..." but NOT data-node-id="..." (require space or < before id)
  const headingRegex = /^<(h[1-6])[^>]*\sid="([^"]+)"[^>]*>(.*?)<\/h[1-6]>/i;

  for (const chunk of nodes) {
    if (!chunk.content) continue;
    
    const match = chunk.content.match(headingRegex);
    if (match) {
      const [, tagName, id, textContent] = match;

      // Clean up the text content (remove any nested HTML tags and decode entities)
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = textContent.replace(/<[^>]*>/g, '');
      const cleanText = tempDiv.textContent.trim();
      
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
  
  const tocContainer = document.getElementById("toc-container"); // Get fresh reference
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
  const tocContainer = document.getElementById("toc-container"); // Get fresh reference
  if (!tocContainer) return;

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
  // Scroller is now pre-rendered in HTML - just find it
  const scroller = container.querySelector('.scroller');
  
  if (!scroller) {
    console.error('❌ Scroller not found in TOC container - check reader.blade.php');
    return;
  }

  console.log('🎯 Using pre-rendered scroller - zero DOM manipulation needed');


  // Clear existing content and repopulate (no DOM structure changes)
  scroller.innerHTML = '';

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
  
  console.log('🚨 FINAL CONTAINER (truncated):', container.innerHTML.substring(0, 200));
  
  // Let's check the masks are actually visible
  const finalMaskTop = container.querySelector('.mask-top');
  const finalMaskBottom = container.querySelector('.mask-bottom');
  if (finalMaskTop && finalMaskBottom) {
    console.log('🚨 FINAL MASK STYLES:');
    console.log('Top mask opacity:', finalMaskTop.style.opacity, 'visibility:', finalMaskTop.style.visibility);
    console.log('Bottom mask opacity:', finalMaskBottom.style.opacity, 'visibility:', finalMaskBottom.style.visibility);
    console.log('Top mask computed:', window.getComputedStyle(finalMaskTop).opacity, window.getComputedStyle(finalMaskTop).visibility);
    console.log('Bottom mask computed:', window.getComputedStyle(finalMaskBottom).opacity, window.getComputedStyle(finalMaskBottom).visibility);
  }
  
  // Masks are now fully styled in HTML - no JavaScript manipulation needed
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
 * Destroy function for cleanup during navigation
 */
export function destroyTocManager() {
  if (tocManager) {
    tocManager.destroy();
    tocManager = null; // Nullify the instance
    // Clear TOC cache as well
    tocCache = {
      data: null,
      lastScanTime: 0,
      bookId: null,
      headingCount: 0
    };
    return true;
  }
  return false;
}

/**
 * Invalidate TOC cache - forces a rescan on next access
 */
export function invalidateTocCache() {
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
  invalidateTocCache();
}

/**
 * Force immediate TOC refresh (bypasses cache)
 */
export async function refreshTOC() {
  invalidateTocCache();
  await generateTableOfContents();
}

/**
 * Get current scroll position from localStorage
 */
function getCurrentScrollPosition() {
  try {
    const scrollKey = getLocalStorageKey("scrollPosition", book);
    
    // Try sessionStorage first
    let savedPosition = sessionStorage.getItem(scrollKey);
    if (!savedPosition || savedPosition === "0") {
      // Fallback to localStorage
      savedPosition = localStorage.getItem(scrollKey);
    }
    
    if (savedPosition && savedPosition !== "0") {
      const parsed = JSON.parse(savedPosition);
      if (parsed && parsed.elementId && /^\d+$/.test(parsed.elementId)) {
        return parseInt(parsed.elementId);
      }
    }
  } catch (e) {
    console.warn("Error reading scroll position:", e);
  }
  
  return null;
}

/**
 * Create the bookmark SVG element (rotated 90 degrees anti-clockwise)
 */
function createBookmarkElement(length = 200, marginLeft = 40) {
  // --- Start of dynamic SVG path generation ---

  // 1. Define original geometry constants to calculate from.
  // These are derived from the original path data.
  const topCapHeight = 2; // The height of the curved top part.
  const tailStructureHeight = 3.216; // The height of the tail structure.
  const fixedStructureHeight = topCapHeight + tailStructureHeight; // Total height of non-scalable parts.

  // 2. Calculate new geometry based on the desired length.
  // Ensure the bookmark is never shorter than its non-scalable parts plus a minimum shaft length.
  const safeLength = Math.max(length, fixedStructureHeight + 20);
  const newShaftHeight = safeLength - fixedStructureHeight;

  // Define the Y-coordinates for the path.
  const y_top_base = 2519;
  const y_shaft_top = y_top_base + topCapHeight; // Y-coord where the straight shaft begins.
  const y_shaft_bottom = y_shaft_top + newShaftHeight; // Y-coord where the straight shaft ends.

  // 3. Dynamically construct the SVG path 'd' attribute.
  // This redraws the path with a new shaft height, while keeping the tail structure relative to the new bottom.
  const d = `M219,${y_shaft_top} L219,${y_shaft_bottom} C219,${y_shaft_bottom + 0.889} 217.923,${y_shaft_bottom + 1.335} 217.293,${y_shaft_bottom + 0.705} L214.707,${y_shaft_bottom - 1.881} C214.317,${y_shaft_bottom - 2.271} 213.683,${y_shaft_bottom - 2.271} 213.293,${y_shaft_bottom - 1.881} L210.707,${y_shaft_bottom + 0.705} C210.077,${y_shaft_bottom + 1.335} 209,${y_shaft_bottom + 0.889} 209,${y_shaft_bottom} L209,${y_shaft_top} C209,2519.895 209.895,2519 211,2519 L217,2519 C218.105,2519 219,2519.895 219,${y_shaft_top}`;
  
  // --- End of dynamic SVG path generation ---

  const bookmarkDiv = document.createElement("div");
  bookmarkDiv.classList.add("toc-bookmark");
  bookmarkDiv.style.cssText = `
    height: 20px;
    width: ${safeLength}px; /* Use calculated responsive length */
    margin-left: ${marginLeft}px; /* Use dynamic margin */
    margin-top: 8px;
    margin-bottom: 8px;
    padding: 0;
    position: relative; /* Establish a positioning context */
  `;
  
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", `${safeLength}`);

  // The viewBox is now also dynamic, framing the newly generated path perfectly.
  const viewBoxHeight = (y_shaft_bottom + 1.335) - y_top_base;
  const viewBoxX = 204; // The path is drawn around X=209-219, so we center the viewBox there.
  const viewBoxWidth = 20;
  svg.setAttribute("viewBox", `${viewBoxX} ${y_top_base} ${viewBoxWidth} ${viewBoxHeight}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Absolutely position and center the SVG, then rotate it.
  svg.style.position = "absolute";
  svg.style.top = "50%";
  svg.style.left = "50%";
  svg.style.transform = "translate(-50%, -50%) rotate(-90deg)";
  
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.style.fill = "#EE4A95"; // Set fill directly on the path.
  // No "transform" attribute is needed on the path itself, as the viewBox handles positioning.
  
  svg.appendChild(path);
  bookmarkDiv.appendChild(svg);
  
  return bookmarkDiv;
}

/**
 * Inserts or updates the bookmark in the TOC, calculating its size and position dynamically.
 */
function updateOrInsertBookmark(container, tocData) {
    const scroller = container.querySelector('.scroller');
    if (!scroller) return;

    // 1. Remove existing bookmark to ensure a clean slate
    const existingBookmark = scroller.querySelector('.toc-bookmark');
    if (existingBookmark) {
        existingBookmark.remove();
    }

    // 2. Check if we should have a bookmark (i.e., we have a scroll position)
    const currentScrollPosition = getCurrentScrollPosition();
    if (!currentScrollPosition) return;

    // 3. --- DYNAMIC BOOKMARK SIZING ---
    const getIndentPx = (headingType) => {
        const dummy = document.createElement(headingType);
        dummy.style.visibility = 'hidden';
        dummy.style.position = 'absolute';
        container.appendChild(dummy);
        const indent = parseInt(window.getComputedStyle(dummy).paddingLeft, 10);
        container.removeChild(dummy);
        return indent;
    };

    let currentSectionHeadingType = 'h1';
    if (tocData && tocData.length > 0) {
        let sectionItem = tocData[0];
        for (let i = 0; i < tocData.length; i++) {
            const item = tocData[i];
            const nextItem = tocData[i + 1];
            const itemId = parseInt(item.id);
            const nextItemId = nextItem ? parseInt(nextItem.id) : Infinity;
            if (currentScrollPosition >= itemId && currentScrollPosition < nextItemId) {
                sectionItem = item;
                break;
            }
        }
        if (currentScrollPosition >= parseInt(tocData[tocData.length - 1].id)) {
            sectionItem = tocData[tocData.length - 1];
        }
        currentSectionHeadingType = sectionItem.type;
    }

    const indentations = { 'h1': 0, 'h2': getIndentPx('h2'), 'h3': getIndentPx('h3'), 'h4': getIndentPx('h4'), 'h5': getIndentPx('h5'), 'h6': getIndentPx('h6') };
    const dynamicMarginLeft = indentations[currentSectionHeadingType] || 0;

    const containerWidth = container.clientWidth;
    const computedContainerStyle = window.getComputedStyle(container);
    const containerPaddingLeft = parseInt(computedContainerStyle.paddingLeft, 10);
    const containerPaddingRight = parseInt(computedContainerStyle.paddingRight, 10);
    const contentAreaWidth = containerWidth - containerPaddingLeft - containerPaddingRight;
    const safetyPadding = 10;
    const maxLength = contentAreaWidth - dynamicMarginLeft - safetyPadding;
    const desiredLength = Math.min(200, Math.max(50, maxLength));

    // 4. Create the bookmark element
    const bookmarkElement = createBookmarkElement(desiredLength, dynamicMarginLeft);

    // 5. Find the correct DOM node to insert the bookmark before
    let insertionRefNode = null;
    for (const child of scroller.children) {
        if (child.tagName === 'A') {
            const href = child.getAttribute('href');
            if (href) {
                const id = parseInt(href.substring(1), 10);
                if (!isNaN(id) && currentScrollPosition < id) {
                    insertionRefNode = child;
                    break;
                }
            }
        }
    }
    
    console.log("📖 Inserting bookmark with calculated size and position.");
    scroller.insertBefore(bookmarkElement, insertionRefNode); // If insertionRefNode is null, it appends to the end.
}


/**
 * Set initial TOC scroll position to bookmark without animation
 */
function setInitialBookmarkPosition(container) {
  const scroller = container.querySelector('.scroller');
  const bookmark = scroller?.querySelector(".toc-bookmark");
  
  if (bookmark && scroller) {
    // Calculate position to show bookmark in upper third of the scroller
    const scrollerHeight = scroller.clientHeight;
    const bookmarkOffset = bookmark.offsetTop;
    const targetScroll = Math.max(0, bookmarkOffset - (scrollerHeight / 3));
    
    // Set position instantly without animation
    scroller.scrollTop = targetScroll;
    
    console.log("📖 Set initial TOC position to bookmark");
  }
}
