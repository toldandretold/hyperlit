// In resources/js/viewInitializers.js

import { book, setCurrentBook } from "./app.js";
import { loadHyperText } from "./initializePage.js";
// ✅ CORRECTED IMPORT: stopObserving comes from divEditor.js
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
import { initializeSelectionHandler } from "./selectionHandler.js";

// ========================================================================
// 1. STATE MANAGEMENT FOR ACTIVE COMPONENTS
// ========================================================================
let activeNavButtons = null;
let activeKeyboardManager = null;

// ========================================================================
// 2. THE CLEANUP FUNCTION (Logic is correct, dependency was wrong)
// ========================================================================
function cleanupReaderView() {
  console.log("🧹 Cleaning up previous reader view...");

  if (activeNavButtons) {
    // activeNavButtons.destroy();
    activeNavButtons = null;
  }
  if (activeKeyboardManager) {
    activeKeyboardManager.destroy();
    activeKeyboardManager = null;
  }

  destroyEditToolbar();

  // This call is now valid because of the corrected import.
  stopObserving();
}

// ========================================================================
// 3. THE TRANSITION ORCHESTRATOR (No changes needed here)
// ========================================================================
export async function transitionToReaderView(bookId) {
  try {
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
// 4. THE SETUP FUNCTION (No changes needed here)
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