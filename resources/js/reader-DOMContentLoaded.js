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
  getNodeChunksFromIndexedDB,
  setupUnloadSync
} from "./cache-indexedDB.js";
import { loadHyperText } from "./initializePage.js";
import {
  attachMarkListeners,
  handleMarkClick,
  handleMarkHover,
  handleMarkHoverOut
} from "./hyperLights.js";
import {
  generateTableOfContents,
  toggleTOC
} from "./toc.js";
import NavButtons from "./nav-buttons.js";
import { currentLazyLoader } from "./initializePage.js";
import sourceManager from './sourceButton.js';
import newBookManager from './newBookButton.js';
//import "./userContainer.js";
import "./editButton.js";
import "./hyperCites.js";
import {attachUnderlineClickListeners} from "./hyperCites.js";
import { initializeBroadcastListener } from "./BroadcastListener.js";
import { initEditToolbar } from "./editToolbar.js";
// resources/js/app.js
import DOMPurify from 'dompurify';
import "./containerCustomization.js";
import "./drag.js";
import { KeyboardManager } from "./keyboardManager.js";
import { fireAndForgetSync } from './createNewBook.js';


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

  
function handlePendingNewBookSync() {
  const pendingSyncJSON = sessionStorage.getItem('pending_new_book_sync');

  if (pendingSyncJSON) {
    console.log("✅ Detected a new book requiring background sync.");
    sessionStorage.removeItem('pending_new_book_sync');

    try {
      const pendingSync = JSON.parse(pendingSyncJSON);
      const { bookId, isNewBook } = pendingSync;

      if (bookId && isNewBook) {
        // ✅ DELAY THE SYNC
        // Wait 1 second after the page loads before starting the sync.
        // This makes the UI feel completely instant.
        setTimeout(() => {
          console.log("🚀 Kicking off delayed background sync...");
          fireAndForgetSync(bookId, isNewBook);
        }, 1000); // 1000ms = 1 second
      }
    } catch (error) {
      console.error("❌ Failed to handle pending book sync:", error);
    }
  }
}


  document.addEventListener("DOMContentLoaded", async () => {
    // Utility function to bust the cache using a lastModified timestamp
    window.getFreshUrl = function (url, lastModified) {
      return `${url}?v=${lastModified}`;
    };

    window.mdFilePath = `/markdown/book/main-text.md`; // Path to raw MD file
    window.isNavigatingToInternalId = false;
    console.log("✅ DOM is ready. Loading Markdown file...");

    // ✅ CALL THE FUNCTION HERE, EARLY IN THE PAGE LOAD
    handlePendingNewBookSync();

    // Initialize IndexedDB.
    window.db = await openDatabase();
    console.log("✅ IndexedDB initialized.");

    // Load the Markdown file.
    await loadHyperText();

    window.keyboardManager = new KeyboardManager();
        window.addEventListener('beforeunload', () => {
      if (window.keyboardManager) {
        window.keyboardManager.destroy();
      }
    });

    restoreScrollPosition();

    attachMarkListeners();

    initializeBroadcastListener();

    setupUnloadSync();
  
    generateTableOfContents("toc-container", "toc-toggle-button");


   // Initialize Navigation Buttons.
  const pageType = document.body.getAttribute("data-page");

  if (pageType === "reader") {
    // Wait for elements to be ready
    setTimeout(() => {
      const navButtons = new NavButtons({
        elementIds: ["nav-buttons", "logoContainer", "topRightContainer"],
        tapThreshold: 15,
      });
      navButtons.init();
    }, 100);
    
    initEditToolbar();
  } else if (pageType === "home") {
    import("./userContainer.js");

    // Wait for elements to be ready AND remove non-existent nav-buttons
    setTimeout(() => {
      const navButtons = new NavButtons({
        elementIds: ["userButtonContainer", "topRightContainer"], // Remove nav-buttons!
        tapThreshold: 15,
      });
      navButtons.init();
    }, 100);

    import('./homepageDisplayUnit.js').then(module => {
      module.initializeHomepageButtons();
    }).catch(error => {
      console.error('Failed to load homepage display unit:', error);
    });
  }
    

    // Get TOC elements here.
    const tocContainer = document.getElementById("toc-container");
    const tocOverlay = document.getElementById("toc-overlay");
    const tocButton = document.getElementById("toc-toggle-button");

    if (!tocContainer || !tocOverlay || !tocButton) {
      console.error("TOC elements are missing in the DOM.");
      return;
    }


document.addEventListener("click", (event) => {
  // 1) Nav/logo buttons – leave them alone
  if (
    event.target.closest("#nav-buttons") ||
    event.target.closest("#logoContainer") ||
    event.target.closest("#topRightContainer")
  ) {
    console.log("Click on navigation element, allowing normal behavior");
    return;
  }

  // 2) If some popup/hyperlight is active *and* the click is *outside* of it, bail
  const activeContainer =
    window.uiState?.activeContainer || window.activeContainer;
  if (activeContainer && activeContainer !== "main-content") {
    console.log(`${activeContainer} is active; checking bounds`);
    const containerEl = document.getElementById(activeContainer);
    if (!containerEl) {
      console.warn("No element for activeContainer, bailing");
      return;
    }
    // ONLY bail if click was *outside* the active container
    if (!event.target.closest(`#${activeContainer}`)) {
      console.log("Click outside active container, skipping link logic");
      return;
    }
    // NOTE: **NO** return here if click was inside.
    console.log("Click inside active container, proceeding to link logic");
  }

  // 3) Now handle <a> clicks
  const link = event.target.closest("a");
  if (!link) return;

  const href = link.getAttribute("href").trim();

  // 4) Pure-hash in-page links (e.g., <a href="#some-id">)
  // Ensure it's not an external link with a hash, e.g., <a href="http://example.com/#hash">
  if (href.startsWith("#") && link.hostname === window.location.hostname) {
    event.preventDefault();
    const targetId = href.slice(1);
    
    // Crucial for browser history (back/forward buttons) and for consistent URL display
    // Don't add to history if the hash is already the current one
    if (window.location.hash !== href) {
        history.pushState(null, "", href);
    }

    // You already have currentLazyLoader.isNavigatingToInternalId = true
    // being set in navigateToInternalId itself.
    navigateToInternalId(targetId, currentLazyLoader);
    console.log(`Intercepted hash-only link → nav to ${href}`);
    return;
  }

  // 5) Same-book + HL_#### detection via the URL API
  const url = new URL(link.href, window.location.origin);
  // external?
  if (url.origin !== window.location.origin) return;

  // path → ["book", "HL_1234"]
  const [bookSegment, hlSegment] = url.pathname.split("/").filter(Boolean);
  const currentBook = window.location.pathname
    .split("/")
    .filter(Boolean)[0];
  const hlMatch = hlSegment && hlSegment.match(/^HL_(\d+)$/);

  if (bookSegment === currentBook && hlMatch) {
    // WE INTERCEPT HERE
    event.preventDefault();
    event.stopImmediatePropagation();
    const highlightId = hlMatch[0];
    const internalId = url.hash ? url.hash.slice(1) : null;

    // pushState to avoid reload and update URL for direct highlight links
    const newPath =
      `/${currentBook}/${highlightId}` + (internalId ? `#${internalId}` : "");
    if (window.location.pathname + window.location.hash !== newPath) {
        window.history.pushState(null, "", newPath);
    }

    console.log(`Internal highlight link → ${highlightId}` +
      (internalId ? `#${internalId}` : ""));
    // navigateToInternalId already handles the highlight ID, and can then look for internalId
    navigateToInternalId(highlightId, currentLazyLoader); // Your navigateToInternalId takes the primary ID (highlight)
    return;
  }

  // 6) Same-book hypercite links (e.g., /book#hypercite_lxk9tha)
  if (bookSegment === currentBook && url.hash) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const internalId = url.hash.slice(1); // Remove the #
    
    // pushState to update URL
    const newPath = `/${currentBook}#${internalId}`;
    if (window.location.pathname + window.location.hash !== newPath) {
        window.history.pushState(null, "", newPath);
    }
    
    console.log(`Same-book hypercite → nav to ${internalId}`);
    navigateToInternalId(internalId, currentLazyLoader);
    return;
  }

    // 7) otherwise, fall through and let the browser do the full navigation
  
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
