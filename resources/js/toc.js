// toc.js

// Import your helper functions and container manager.
import { getNodeChunksFromIndexedDB } from "./cache-indexedDB.js";
import { book } from "./app.js";
import { navigateToInternalId } from "./scrolling.js"; // your internal navigation function
import { ContainerManager } from "./container-manager.js";
import { currentLazyLoader } from "./initializePage.js";

// Get DOM elements for TOC container, overlay, and toggle button.
export const tocContainer = document.getElementById("toc-container");
export const tocOverlay = document.getElementById("toc-overlay");
export const tocButton = document.getElementById("toc-toggle-button");

// Create a container manager instance for the TOC.  
// Assuming that "main-content" or "nav-buttons" should be frozen when TOC is open.
const tocManager = new ContainerManager(
  "toc-container",
  "toc-overlay",
  "toc-toggle-button",
  ["main-content", "nav-buttons"]
);

/**
 * Generates the Table of Contents.
 *
 * This function fetches nodeChunks from IndexedDB, filters out heading nodes,
 * generates the TOC data and renders the TOC into the container indicated by tocContainer.
 */
export async function generateTableOfContents() {
  if (!tocContainer) {
    console.error("TOC container not found!");
    return;
  }

  // Retrieve nodeChunks from IndexedDB for the current book.
  let nodeChunks = [];
  try {
    nodeChunks = await getNodeChunksFromIndexedDB(book);
  } catch (e) {
    console.error("Error retrieving nodeChunks from IndexedDB:", e);
    return;
  }

  // Filter only heading nodes (h1 through h6) and create TOC data.
  const headingTags = ["h1", "h2", "h3", "h4", "h5", "h6"];
  const tocData = nodeChunks
    .filter((node) => headingTags.includes(node.type))
    .map((node) => ({
      id: node.startLine,
      type: node.type,
      text: node.plainText.trim(),
      link: `#${node.startLine}`,
    }));

  // Render the TOC in the container.
  renderTOC(tocContainer, tocData);

  // Add click handler to the TOC container for navigation.
  tocContainer.addEventListener("click", (event) => {
    // Look for the closest anchor element if clicked within one.
    const link = event.target.closest("a");
    if (link) {
      event.preventDefault();
      // Close the TOC using the container manager.
      tocManager.closeContainer();
      const targetId = link.hash.substring(1); // e.g. "55" from "#55"
      if (!targetId) return;
      console.log(`📌 Navigating via TOC to: ${targetId}`);
      navigateToInternalId(targetId, currentLazyLoader);
    }
  });
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

  // Create the TOC entries.
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
    container.appendChild(anchor);
  });
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
