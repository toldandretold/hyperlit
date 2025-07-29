// In resources/js/viewInitializers.js

import { book } from './app.js';
import { loadHyperText } from './initializePage.js';
import { initEditToolbar } from './editToolbar.js';
import NavButtons from './nav-buttons.js';
import { restoreScrollPosition } from './scrolling.js';
import { attachMarkListeners } from './hyperLights.js';
import { initializeBroadcastListener } from './BroadcastListener.js';
import { setupUnloadSync } from './cache-indexedDB.js';
import { generateTableOfContents } from './toc.js';
import { KeyboardManager } from './keyboardManager.js';
import { handleAutoEdit, initializeEditButtonListeners } from './editButton.js';

// This is now the single, authoritative function to make the reader page "live".
export async function initializeReaderView() {
  // Use the global `book` variable, which is now correctly updated by the viewManager.
  const currentBookId = book;
  console.log(`🚀 Initializing Reader View for book: ${currentBookId}`);
  
  // 1. Load the book's content.
  await loadHyperText(currentBookId);

  // 2. Set up all the core features.
  // This is the logic you had in reader-DOMContentLoaded.js
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

  // 3. Initialize UI components.
  const navButtons = new NavButtons({
    elementIds: ["nav-buttons", "logoContainer", "topRightContainer"],
    tapThreshold: 15,
  });
  navButtons.init();

  initializeEditButtonListeners();

  initEditToolbar({
    toolbarId: "edit-toolbar",
    editableSelector: ".main-content[contenteditable='true']",
    currentBookId: currentBookId
  });

  // 4. Check if we need to automatically enter edit mode.
  handleAutoEdit();
}