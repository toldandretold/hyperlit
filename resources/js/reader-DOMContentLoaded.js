import {
    book,
    markdownContent
} from './app.js'; 

import {
    convertMarkdownToHtml
} from './convert-markdown.js';

import { // observer, 
    isValidContentElement,
    restoreScrollPosition,
    navigateToInternalId
} from './scrolling.js';

import { 
    refContainer, 
    refOverlay, 
    isRefOpen,
    openReferenceContainer,
    closeReferenceContainer,
    displayFootnote
} from './footnotes.js';

import { 
    openDatabase, 
    getNodeChunksFromIndexedDB
} from './cache-indexedDB.js';

import {
    loadMarkdownFile
} from './initializePage.js';

import {
    attachMarkListeners,
    handleMarkClick,
    handleMarkHover,
    handleMarkHoverOut
} from './hyper-lights-cites.js';

import {
    generateTableOfContents,
    tocContainer,
    tocOverlay,
    tocButton,
    toggleTOC
} from './toc.js';

import NavButtons from "./nav-buttons.js";

import { currentLazyLoader } from './initializePage.js';



  

if (!window.isInitialized) {
    window.isInitialized = true;

    document.addEventListener("DOMContentLoaded", async () => {


        // Utility function to bust the cache using a lastModified timestamp
        window.getFreshUrl = function(url, lastModified) {
          return `${url}?v=${lastModified}`;
        };
        window.mdFilePath = `/markdown/${book}/main-text.md`;  // Path to raw MD file

        window.isNavigatingToInternalId = false;

        console.log("✅ DOM is ready. Loading Markdown file...");

        // cache-indexedDB.js
        window.db = await openDatabase();
        console.log("✅ IndexedDB initialized.");

        // initializePage.js
        await loadMarkdownFile();
        
        // gets scroll position from session storage 
        restoreScrollPosition();

        attachMarkListeners();

        // Load Table of Contents
        generateTableOfContents("toc-container", "toc-toggle-button");


        const navButtons = new NavButtons({
            elementId: "nav-buttons", // This should match the id in your HTML.
            tapThreshold: 10, // Adjust if needed.
            });
        navButtons.init();
        
        if (!tocContainer || !tocOverlay || !tocButton) {
            console.error("TOC elements are missing in the DOM.");
            return;
        }

        // ✅ Internal Link Navigation Handling
       document.addEventListener("click", (event) => {
          const link = event.target.closest("a");
          if (link && link.hash && link.hash.startsWith("#")) {
            event.preventDefault();
            const targetId = link.hash.substring(1);
            // Pass the lazyLoader instance as the second argument.
            navigateToInternalId(targetId, currentLazyLoader);
          }
        });

        // ✅ Footnotes Click Handling (Replaces `jsonPath`)
        /*document.addEventListener("click", async (event) => {
    const noteElement = event.target.closest("sup.note");
    if (noteElement) {
        event.preventDefault();
        
        // Get the note ID from the data-note-id attribute
        const noteId = noteElement.dataset.noteId;
        if (!noteId) {
            console.warn("Missing note ID for footnote.");
            return;
        }

        // Find the current book ID from the container
        const container = noteElement.closest(".main-content");
        const bookId = container?.id || "latest";
        
        try {
            // Retrieve footnotes from IndexedDB
            const footnotes = await getFootnotesFromIndexedDB(bookId);
            if (!footnotes || footnotes.length === 0) {
                console.warn(`No footnotes found for book ${bookId}`);
                return;
            }

            // Find the footnote with matching ID
            const footnote = footnotes.find(fn => fn.id === noteId);
            if (!footnote) {
                console.warn(`Footnote with ID ${noteId} not found.`);
                return;
            }

            // Convert footnote content to HTML if needed
            const footnoteContent = footnote.content;
            const footnoteHtml = typeof footnoteContent === 'string' 
                ? convertMarkdownToHtml(footnoteContent) 
                : footnoteContent;

            // Display the footnote content
            openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
            
            console.log(`Displayed footnote ${noteId}`);
        } catch (error) {
            console.error("Error retrieving footnote:", error);
        }
    }
});*/


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
          // We assume that when rendering, the node element's id is set to its startLine.
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
            const nodeData = nodeChunks.find((node) => parseInt(node.startLine, 10) === nodeLine);
            if (!nodeData) {
              console.warn(`Node data not found for startLine: ${nodeLine}`);
              return;
            }

            // Now search in that node's footnotes for the matching note by noteId.
            if (!nodeData.footnotes || nodeData.footnotes.length === 0) {
              console.warn(`No footnotes stored for node at line ${nodeLine}`);
              return;
            }
            const footnoteData = nodeData.footnotes.find((fn) => fn.id === noteId);
            if (!footnoteData) {
              console.warn(`Footnote data not found for note id: ${noteId} in node starting at line ${nodeLine}`);
              return;
            }

            // Convert the footnote's Markdown content to HTML.
            // Assume convertMarkdownToHtml is available in your scope.
            const footnoteContentMarkdown = footnoteData.content || "";
            const footnoteHtmlContent = convertMarkdownToHtml(footnoteContentMarkdown);

            // Build the HTML to display in the ref-container/modal.
            const htmlToDisplay = `
              <div class="footnote-modal-content">
                <div class="footnote-text">
                  ${footnoteHtmlContent}
                </div>
              </div>
            `;

            // Open the reference container (assumes openReferenceContainer is defined).
            openReferenceContainer(htmlToDisplay);

            console.log(`Displayed footnote ${noteId} from node at line ${nodeLine}`);
          } catch (error) {
            console.error("Error retrieving nodeChunks from IndexedDB or displaying footnote:", error);
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
