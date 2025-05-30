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
} from "./hyperLights.js";
import {
  generateTableOfContents,
  toggleTOC
  // We no longer import tocContainer, tocOverlay, tocButton because
  // we'll fetch them after DOM is ready.
} from "./toc.js";
import NavButtons from "./nav-buttons.js";
import { currentLazyLoader } from "./initializePage.js";
import sourceManager from './sourceButton.js';
import newBookManager from './newBookButton.js';
import "./editButton.js";
import "./hyperCites.js";
import {attachUnderlineClickListeners} from "./hyperCites.js";
import { initializeBroadcastListener } from "./BroadcastListener.js";
import { initEditToolbar } from "./editToolbar.js";



window.uiState = {
  activeContainer: "main-content",
  isNavigating: false,
  navElementsVisible: true,
  
  setActiveContainer(containerId) {
    console.log(`Setting active container: ${containerId}`);
    this.activeContainer = containerId;
    // Dispatch a custom event that components can listen for
    document.dispatchEvent(new CustomEvent('containerChanged', {
      detail: { containerId }
    }));
  }
};

const editMode = document.body.dataset.editMode === '1';
if (editMode) {
  // 1) Activate your “Edit” button UI
  document.getElementById('edit-button')?.classList.add('active');
  // 2) Turn on contentEditable for whatever divs you want
  document.querySelectorAll('.editable').forEach(el => {
    el.contentEditable = 'true';
  });
  // 3) Any other JS you need to run in edit mode…
}

if (!window.isInitialized) {
  window.isInitialized = true;

  document.addEventListener("DOMContentLoaded", async () => {
    // Utility function to bust the cache using a lastModified timestamp
    window.getFreshUrl = function (url, lastModified) {
      return `${url}?v=${lastModified}`;
    };

    window.mdFilePath = `/markdown/book/main-text.md`; // Path to raw MD file
    window.isNavigatingToInternalId = false;
    console.log("✅ DOM is ready. Loading Markdown file...");

    // Initialize IndexedDB.
    window.db = await openDatabase();
    console.log("✅ IndexedDB initialized.");

    // Load the Markdown file.
    await loadMarkdownFile();

    restoreScrollPosition();

    attachMarkListeners();

    initializeBroadcastListener();
  
    generateTableOfContents("toc-container", "toc-toggle-button");


    // Initialize Navigation Buttons.
    // Get the data-page attribute from the <body> tag
    const pageType = document.body.getAttribute("data-page");

    // Initialize Navigation Buttons differently based on pageType
    if (pageType === "reader") {
      const navButtons = new NavButtons({
        elementIds: ["nav-buttons", "logoContainer", "topRightContainer"],
        tapThreshold: 15,
      });

      navButtons.init();
    } else if (pageType === "home") {
  const navButtons = new NavButtons({
    elementIds: ["nav-buttons", "userContainer", "topRightContainer"],
    tapThreshold: 15,
  });

  navButtons.init();

  import('./homepageDisplayUnit.js').then(module => {
    module.initializeHomepageButtons();
  }).catch(error => {
    console.error('Failed to load homepage display unit:', error);
  });
}


    // Initialize the toolbar
    initEditToolbar();

    // Get TOC elements here.
    const tocContainer = document.getElementById("toc-container");
    const tocOverlay = document.getElementById("toc-overlay");
    const tocButton = document.getElementById("toc-toggle-button");

    if (!tocContainer || !tocOverlay || !tocButton) {
      console.error("TOC elements are missing in the DOM.");
      return;
    }


document.addEventListener("click", (event) => {
  // First, check if we're clicking on a navigation element or button
  if (event.target.closest("#nav-buttons") || 
      event.target.closest("#logoContainer") || 
      event.target.closest("#topRightContainer")) {
    console.log("Click on navigation element, allowing normal behavior");
    return; // Let the navigation buttons handle their own clicks
  }
  
  // Check if any container is active (not just source-container)
  const activeContainer = window.uiState?.activeContainer || window.activeContainer;
  
  console.log("Active container:", activeContainer);
  
  if (activeContainer && activeContainer !== "main-content") {
    console.log(`${activeContainer} is active; skipping link handling`);
    
    // Only stop propagation for clicks outside the active container
    // This allows clicks inside the container to work normally
    const containerElement = document.getElementById(activeContainer);
    if (containerElement && !event.target.closest(`#${activeContainer}`)) {
      console.log("Click outside active container, preventing default");
      // Don't prevent default here, as it might interfere with other click handlers
      // Just return early to skip the link handling
      return;
    }
    
    // If we're here, the click was inside the active container
    // Let it proceed normally
    return;
  }

  // If we get here, no container is active, so proceed with link handling
  console.log("No active container, checking for links");
  const link = event.target.closest("a");
  if (!link) return; // Not a link click
  
  const href = link.getAttribute("href").trim();
  
  // Handle hash-only links (internal navigation)
  if (href.startsWith("#")) {
    event.preventDefault();
    const targetId = link.hash.substring(1);
    navigateToInternalId(targetId, currentLazyLoader);
    console.log(
      `Navigating internally to ${targetId} in container: ${currentLazyLoader.container.id}`
    );
    return;
  }
  
  // Handle links to highlights within the same book
  // Check if the link is to the current book and contains a highlight ID
  const currentPath = window.location.pathname;
  const currentBook = currentPath.split('/').filter(Boolean)[0]; // Get the book name from the URL
  
  // Parse the href to check if it's a link to a highlight in the same book
  const hrefParts = href.split('/');
  const isInternalBookLink = href.includes(currentBook);
  
  // Check for highlight ID pattern in the URL (HL_followed by numbers)
  const highlightMatch = href.match(/\/HL_\d+/);
  
  if (isInternalBookLink && highlightMatch) {
    event.preventDefault();
    
    // Extract the highlight ID
    const highlightId = highlightMatch[0].substring(1); // Remove the leading slash
    console.log(`Detected internal highlight link to: ${highlightId}`);
    
    // Check if there's a hash for an internal element within the highlight
    const internalId = link.hash ? link.hash.substring(1) : null;
    
    // If there's an internal ID, store it in the URL hash
    if (internalId) {
      // Update the URL hash without triggering a page reload
      window.history.pushState(null, '', `#${internalId}`);
      console.log(`Setting internal ID in hash: ${internalId}`);
    } else {
      // Clear the hash if there's no internal ID
      window.history.pushState(null, '', window.location.pathname);
    }
    
    // Navigate to the highlight
    navigateToInternalId(highlightId, currentLazyLoader);
    
    return;
  }

  // For links that don't start with "#", let them be resolved normally
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
