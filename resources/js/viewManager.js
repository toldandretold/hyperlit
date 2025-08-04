// In resources/js/viewInitializers.js

import { book, setCurrentBook } from "./app.js";
import { loadHyperText } from "./initializePage.js";
import { stopObserving, initTitleSync } from "./divEditor.js";
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
import {
  initializeSelectionHandler,
  destroySelectionHandler,
} from "./selectionHandler.js";

// State management and cleanup are correct.
let activeNavButtons = null;
let activeKeyboardManager = null;

function cleanupReaderView() {
  console.log("🧹 Cleaning up previous reader view...");
  if (activeNavButtons) {
    activeNavButtons = null;
  }
  if (activeKeyboardManager) {
    activeKeyboardManager.destroy();
    activeKeyboardManager = null;
  }
  destroyEditToolbar();
  stopObserving();
  destroySelectionHandler();
}

// ========================================================================
// ✅ THIS IS THE FINAL, CORRECTED TRANSITION FUNCTION
// ========================================================================
export async function transitionToReaderView(bookId) {
  try {
    cleanupReaderView();

    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) throw new Error("Failed to fetch reader page HTML");
    const htmlString = await response.text();

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, "text/html");

    // --- This is the robust update logic ---
    const newBody = newDoc.body;
    const newTitle = newDoc.title;

    // Replace the entire body content and its attributes
    document.body.innerHTML = newBody.innerHTML;

    // Manually copy over the data attributes from the new body
    for (const { name, value } of newBody.attributes) {
      document.body.setAttribute(name, value);
    }

    // Update the page title
    document.title = newTitle;
    // --- End of robust update logic ---

    setCurrentBook(bookId);
    history.pushState({}, "", `/${bookId}/edit?target=1&edit=1`);

    // Now that the DOM is completely new and correct, initialize it.
    await initializeReaderView();
  } catch (error) {
    console.error("SPA Transition Failed:", error);
    // Fallback to a full page load if the SPA transition fails
    window.location.href = `/${bookId}/edit?target=1&edit=1`;
  }
}

// The setup function is correct and does not need to be changed.
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

  await initTitleSync(currentBookId);

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