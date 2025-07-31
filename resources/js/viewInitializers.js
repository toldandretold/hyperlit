// In resources/js/viewInitializers.js

import { book } from './app.js';
import { loadHyperText } from './initializePage.js';
import { initEditToolbar } from './editToolbar.js';
import NavButtons from './nav-buttons.js';
import { restoreScrollPosition } from './scrolling.js';
import { attachMarkListeners, 
         initializeHighlightingControls,
         initializeHighlightManager
          } from './hyperLights.js';
import { initializeHypercitingControls } from './hyperCites.js';
import { initializeBroadcastListener } from './BroadcastListener.js';
import { setupUnloadSync } from './cache-indexedDB.js';
import { generateTableOfContents } from './toc.js';
import { KeyboardManager } from './keyboardManager.js';
import { handleAutoEdit, initializeEditButtonListeners, updateEditButtonVisibility } from './editButton.js';
import { initializeSourceButtonListener } from './sourceButton.js';

export async function initializeReaderView() {
  const currentBookId = book;
  console.log(`🚀 Initializing Reader View for book: ${currentBookId}`);
  
  const loadPromise = loadHyperText(currentBookId);

  setTimeout(() => {
    console.log("✅ DOM settled. Initializing UI components...");
    
    // =================================================================
    // THE FIX: Create a NEW, FRESH NavButtons instance for the reader page.
    // This instance only knows about the reader page DOM and has no stale references.
    // =================================================================
    const navButtons = new NavButtons({
      elementIds: ["nav-buttons", "logoContainer", "topRightContainer"],
      tapThreshold: 15,
    });
    navButtons.init(); // This will find the new elements and attach listeners.

    initializeEditButtonListeners();
    initializeSourceButtonListener();
    updateEditButtonVisibility(currentBookId);
    initializeHighlightManager();
    initializeHighlightingControls(currentBookId);
    initializeHypercitingControls(currentBookId);

    initEditToolbar({
      toolbarId: "edit-toolbar",
      editableSelector: ".main-content[contenteditable='true']",
      currentBookId: currentBookId
    });
  }, 0);

  await loadPromise;
  console.log("✅ Content loading process complete.");

  // Initialize everything else that was waiting.
  window.keyboardManager = new KeyboardManager();
  window.addEventListener('beforeunload', () => {
    if (window.keyboardManager) window.keyboardManager.destroy();
  });

  restoreScrollPosition();
  attachMarkListeners();
  initializeBroadcastListener();
  setupUnloadSync();
  generateTableOfContents("toc-container", "toc-toggle-button");
  handleAutoEdit();
}