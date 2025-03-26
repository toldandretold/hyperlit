import { book, markdownContent } from "./app.js";
import { convertMarkdownToHtml } from "./convert-markdown.js";
import {
  isValidContentElement,
  restoreScrollPosition,
  navigateToInternalId
} from "./scrolling.js";
import {
  refContainer,
  refOverlay,
  isRefOpen,
  openReferenceContainer,
  closeReferenceContainer,
  displayFootnote
} from "./footnotes.js";
import {
  openDatabase,
  getNodeChunksFromIndexedDB
} from "./cache-indexedDB.js";
import { loadMarkdownFile } from "./initializePage.js";
import {
  attachMarkListeners,
  handleMarkClick,
  handleMarkHover,
  handleMarkHoverOut
} from "./hyper-lights-cites.js";
import {
  generateTableOfContents,
  toggleTOC
  // We no longer import tocContainer, tocOverlay, tocButton because
  // we'll fetch them after DOM is ready.
} from "./toc.js";
import NavButtons from "./nav-buttons.js";
import { currentLazyLoader } from "./initializePage.js";

if (!window.isInitialized) {
  window.isInitialized = true;

  document.addEventListener("DOMContentLoaded", async () => {
    // Utility function to bust the cache using a lastModified timestamp
    window.getFreshUrl = function (url, lastModified) {
      return `${url}?v=${lastModified}`;
    };
    window.mdFilePath = `/markdown/${book}/main-text.md`; // Path to raw MD file

    window.isNavigatingToInternalId = false;

    console.log("✅ DOM is ready. Loading Markdown file...");

    // Initialize IndexedDB.
    window.db = await openDatabase();
    console.log("✅ IndexedDB initialized.");

    // Load the Markdown file.
    await loadMarkdownFile();

    // Get scroll position from session storage.
    restoreScrollPosition();

    // Attach mark listeners.
    attachMarkListeners();

    // Now that DOM is ready, the TOC elements exist.
    // Generate the Table of Contents.
    // (Note: If your generateTableOfContents() function expects IDs,
    // make sure that function internally queries for those elements.)
    generateTableOfContents("toc-container", "toc-toggle-button");

    // Initialize Navigation Buttons.
    const navButtons = new NavButtons({
      elementIds: ["nav-buttons", "logoContainer"],
      tapThreshold: 10,
    });

    navButtons.init();

    // Get TOC elements here.
    const tocContainer = document.getElementById("toc-container");
    const tocOverlay = document.getElementById("toc-overlay");
    const tocButton = document.getElementById("toc-toggle-button");

    if (!tocContainer || !tocOverlay || !tocButton) {
      console.error("TOC elements are missing in the DOM.");
      return;
    }

   // ✅ Internal Link Navigation Handling
    document.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (!link || !link.hash) return; // No hash? No custom handling.

      // Create a URL object from the link.
      // (This will resolve relative URLs based on the current window.location)
      const linkUrl = new URL(link.href, window.location.href);

      // Check if the hash-only navigation or same-book navigation should happen.
      // One option: compare pathname OR check if the pathname is empty or "/"
      // relative to the current location; adjust according to your app.

      if (
        linkUrl.pathname === window.location.pathname ||
        // Optionally, if you want to cover relative links that start with "#":
        linkUrl.href.startsWith(window.location.origin + window.location.pathname + "#")
      ) {
        // It's an in-page anchor or the same book.
        event.preventDefault();
        const targetId = linkUrl.hash.substring(1);
        // Navigate via lazy loader.
        navigateToInternalId(targetId, currentLazyLoader);
        console.log(
          `Navigating internally to ${targetId} in container: ${currentLazyLoader.container.id}`
        );
      } else {
        // If the link points to a different book (page):
        // You may want to let the browser handle it normally.
        // If you want to force a full navigation, you could use:
        console.log(
          `Navigating externally to a different book: ${linkUrl.pathname} with hash ${linkUrl.hash}`
        );
      }
    });


    document.addEventListener("click", async (event) => {
      const noteElement = event.target.closest("sup.note");
      if (!noteElement) return;

      event.preventDefault();

      // Get the note ID from data attribute.
      const noteId = noteElement.dataset.noteId;
      if (!noteId) {
        console.warn("Missing note ID for footnote.");
        return;
      }

      // Find the closest parent element with an id.
      const nodeEl = noteElement.closest("[id]");
      if (!nodeEl) {
        console.warn("Could not determine the parent node element.");
        return;
      }

      // Use the parent's id (startLine) to find the node data.
      const nodeIdentifier = nodeEl.id; // Expected to be a string like "47"
      const nodeLine = parseInt(nodeIdentifier, 10);
      if (isNaN(nodeLine)) {
        console.warn("Invalid node identifier:", nodeIdentifier);
        return;
      }

      // Get the current bookId.
      const container = noteElement.closest(".main-content");
      const bookId = container?.id || "latest";

      try {
        // Retrieve nodeChunks from IndexedDB.
        const nodeChunks = await getNodeChunksFromIndexedDB(bookId);
        if (!nodeChunks || nodeChunks.length === 0) {
          console.error("No nodeChunks available in IndexedDB");
          return;
        }

        // Look for the node whose startLine matches nodeLine.
        const nodeData = nodeChunks.find(
          (node) => parseInt(node.startLine, 10) === nodeLine
        );
        if (!nodeData) {
          console.warn(`Node data not found for startLine: ${nodeLine}`);
          return;
        }

        // Search for the matching note in the node's footnotes.
        if (!nodeData.footnotes || nodeData.footnotes.length === 0) {
          console.warn(`No footnotes stored for node at line ${nodeLine}`);
          return;
        }
        const footnoteData = nodeData.footnotes.find(
          (fn) => fn.id === noteId
        );
        if (!footnoteData) {
          console.warn(
            `Footnote data not found for note id: ${noteId} in node starting at line ${nodeLine}`
          );
          return;
        }

        // Convert the footnote's Markdown content to HTML.
        const footnoteContentMarkdown = footnoteData.content || "";
        const footnoteHtmlContent = convertMarkdownToHtml(
          footnoteContentMarkdown
        );

        // Build the HTML to display in the reference container/modal.
        const htmlToDisplay = `
          <div class="footnote-modal-content">
            <div class="footnote-text">
              ${footnoteHtmlContent}
            </div>
          </div>
        `;

        // Open the reference container.
        openReferenceContainer(htmlToDisplay);
        console.log(
          `Displayed footnote ${noteId} from node at line ${nodeLine}`
        );
      } catch (error) {
        console.error(
          "Error retrieving nodeChunks from IndexedDB or displaying footnote:",
          error
        );
      }
    });

    // ✅ Detect Navigation Type
    const navEntry = performance.getEntriesByType("navigation")[0] || {};
    const navType = navEntry.type || "navigate";

    if (navType === "reload") {
      console.log("🔄 Page refreshed (F5 or Ctrl+R).");
    } else if (navType === "back_forward") {
      console.log("⬅️➡️ Navigation via Back/Forward buttons.");
    } else {
      console.log("🔗 Entered page via direct URL or new tab.");
    }
  });
}
