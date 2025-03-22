import { book } from './app.js';
import { navigateToInternalId
        } from './scrolling.js';
import { parseInlineMarkdown } from './convert-markdown.js';
import { 
    getFootnotesFromIndexedDB,
    saveFootnotesToIndexedDB 
} from './cache-indexedDB.js';
import { ContainerManager } from './container-manager.js';
import { currentLazyLoader } from './initializePage.js';

// Create a container manager for TOC
const tocManager = new ContainerManager("toc-container", "toc-overlay", "toc-toggle-button", ["main-content", "nav-buttons"]);

// Export the DOM elements for backward compatibility
export const tocContainer = document.getElementById("toc-container");
export const tocOverlay = document.getElementById("toc-overlay");
export const tocButton = document.getElementById("toc-toggle-button");

export async function generateTableOfContents(tocContainerId, toggleButtonId) {
  try {
    console.log("📖 Generating Table of Contents...");

    // ✅ Check if footnotes data is already loaded
    let sections = window.footnotesData;

    // ✅ Try to load from IndexedDB if not in memory
    if (!sections) {
      console.log("⚠️ No footnotes in memory, checking IndexedDB...");
      sections = await getFootnotesFromIndexedDB(book);
    }

    if (!tocContainer) {
      console.error(`❌ TOC container with ID "${tocContainerId}" not found.`);
      return;
    }

    tocContainer.innerHTML = ""; // Clear previous TOC content

    let firstHeadingAdded = false;

    sections.forEach((section) => {
      if (section.heading) {
        const headingContent = Object.values(section.heading)[0]; // Get the heading text
        const headingLevel = Object.keys(section.heading)[0]; // Get the heading level (e.g., h1, h2)
        const lineNumber = section.heading.line_number; // Get the line number

        if (headingContent && headingLevel && lineNumber) {
          // Convert Markdown to inline HTML for heading content
          const headingHtml = parseInlineMarkdown(headingContent);

          // Create the heading element dynamically (e.g., <h1>, <h2>)
          const headingElement = document.createElement(headingLevel);
          headingElement.innerHTML = headingHtml;

          // Add the "first" class to the first heading
          if (!firstHeadingAdded) {
            headingElement.classList.add("first");
            firstHeadingAdded = true;
          }

          // Create a link wrapping the heading
          const link = document.createElement("a");
          link.href = `#${lineNumber}`;
          link.appendChild(headingElement);

          // Create a container for the link
          const tocItem = document.createElement("div");
          tocItem.classList.add("toc-item", headingLevel); // Optional: Add class for styling
          tocItem.appendChild(link);

          // Append the container to the TOC
          tocContainer.appendChild(tocItem);
        }
      }
    });

    // Add click handler for TOC links
    tocContainer.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (link) {
        event.preventDefault();
        tocManager.closeContainer();
        const targetId = link.hash?.substring(1);
        if (!targetId) return;
        console.log(`📌 Navigating via TOC to: ${targetId}`);
        navigateToInternalId(targetId, currentLazyLoader);
      }
    });

  } catch (error) {
    console.error("❌ Error generating Table of Contents:", error);
  }
}

// Export functions for toggling TOC
export function openTOC() {
  tocManager.openContainer();
}

export function closeTOC() {
  tocManager.closeContainer();
}

export function toggleTOC() {
  tocManager.toggleContainer();
}
