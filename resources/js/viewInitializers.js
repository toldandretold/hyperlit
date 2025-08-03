// In resources/js/viewInitializers.js

import { book, setCurrentBook } from "./app.js";
import { loadHyperText } from "./initializePage.js";
import { stopObserving } from "./divEditor.js";
import { initEditToolbar, destroyEditToolbar } from "./editToolbar.js";
import NavButtons from "./nav-buttons.js";
import { restoreScrollPosition } from "./scrolling.js";
import {
  attachMarkListeners,
  initializeHighlightingControls,
  initializeHighlightManager,
} from "./hyperLights.js";
import { initializeHypercitingControls } from "./hyperCites.js";
import { initializeBroadcastListener } from "./BroadcastListener.js";
import { setupUnloadSync } from "./cache-indexedDB.js";
import { generateTableOfContents } from "./toc.js";
import { KeyboardManager } from "./keyboardManager.js";
import {
  handleAutoEdit,
  initializeEditButtonListeners,
  updateEditButtonVisibility,
} from "./editButton.js";
import { initializeSourceButtonListener } from "./sourceButton.js";
// ✅ CORRECTED IMPORT: Bring in both functions.
import {
  initializeSelectionHandler,
  destroySelectionHandler,
} from "./selectionHandler.js";

// ========================================================================
// 1. STATE MANAGEMENT FOR ACTIVE COMPONENTS
// ========================================================================
let activeNavButtons = null;
let activeKeyboardManager = null;

// ========================================================================
// 2. THE CLEANUP FUNCTION
// ========================================================================
function cleanupReaderView() {
  console.log("🧹 Cleaning up previous reader view...");

  if (activeNavButtons) {
    // activeNavButtons.destroy(); // Assuming it has a destroy method
    activeNavButtons = null;
  }
  if (activeKeyboardManager) {
    activeKeyboardManager.destroy();
    activeKeyboardManager = null;
  }

  destroyEditToolbar();
  stopObserving();

  // ✅ THE FIX: Explicitly destroy the old selection handler
  // This removes its event listener and clears its stale DOM references.
  destroySelectionHandler();
}

// ========================================================================
// 3. THE TRANSITION ORCHESTRATOR (No changes needed)
// ========================================================================
export async function transitionToReaderView(bookId) {
  try {
    // This now correctly cleans up the old selection handler before proceeding.
    cleanupReaderView();

    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) throw new Error("Failed to fetch reader page HTML");
    const htmlString = await response.text();

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, "text/html");

    const currentPageWrapper = document.getElementById("page-wrapper");
    const newPageWrapper = newDoc.getElementById("page-wrapper");

    if (!currentPageWrapper || !newPageWrapper) {
      console.error(
        "Critical error: #page-wrapper not found. Falling back to full reload.",
      );
      window.location.href = `/${bookId}/edit?target=1&edit=1`;
      return;
    }
    currentPageWrapper.innerHTML = newPageWrapper.innerHTML;

    document.body.dataset.page = newDoc.body.dataset.page || "reader";
    document.body.dataset.editMode = newDoc.body.dataset.editMode || "0";
    document.title = newDoc.title;

    setCurrentBook(bookId);
    history.pushState({}, "", `/${bookId}/edit?target=1&edit=1`);
    await initializeReaderView();
  } catch (error) {
    console.error("SPA Transition Failed:", error);
    window.location.href = `/${bookId}/edit?target=1&edit=1`;
  }
}

// ========================================================================
// 4. THE SETUP FUNCTION (No changes needed)
// ========================================================================
export async function initializeReaderView() {
  const currentBookId = book;
  console.log(`🚀 Initializing Reader View for book: ${currentBookId}`);

  const loadPromise = loadHyperText(currentBookId);

  setTimeout(() => {
    console.log("✅ DOM settled. Initializing UI components...");

    activeNavButtons = new NavButtons({
      elementIds: ["nav-buttons", "logoContainer", "topRightContainer"],
      tapThreshold: 15,
    });
    activeNavButtons.init();

    initializeEditButtonListeners();
    initializeSourceButtonListener();
    updateEditButtonVisibility(currentBookId);
    initializeHighlightManager();
    initializeHighlightingControls(currentBookId);
    initializeHypercitingControls(currentBookId);

    // This now initializes the handler with fresh references from the new DOM.
    initializeSelectionHandler();

    initEditToolbar({
      toolbarId: "edit-toolbar",
      editableSelector: ".main-content[contenteditable='true']",
      currentBookId: currentBookId,
    });
  }, 0);

  await loadPromise;
  console.log("✅ Content loading process complete.");

  activeKeyboardManager = new KeyboardManager();

  window.addEventListener("beforeunload", () => {
    if (activeKeyboardManager) activeKeyboardManager.destroy();
  });

  restoreScrollPosition();
  attachMarkListeners();
  initializeBroadcastListener();
  setupUnloadSync();
  generateTableOfContents("toc-container", "toc-toggle-button");
  handleAutoEdit();
}