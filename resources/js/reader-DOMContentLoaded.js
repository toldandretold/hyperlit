// =================================================================
// THE KEY FIX: Import app.js first to set up initial state.
// This line ensures the 'book' variable is defined before anything else runs.
import { book } from './app.js'; 
// =================================================================

import { openDatabase } from "./cache-indexedDB.js";
import { fireAndForgetSync } from './createNewBook.js';
import { initializeReaderView } from './viewInitializers.js';
import { initializeHomepage } from './homepage.js';
import NavButtons from './nav-buttons.js';

export const navButtons = new NavButtons({
  // Give it ALL possible element IDs it might ever need to control
  elementIds: ["nav-buttons", "logoContainer", "topRightContainer", "userButtonContainer"],
  tapThreshold: 15,
});

// This function for handling a pending sync after a reload is still correct.
function handlePendingNewBookSync() {
  const pendingSyncJSON = sessionStorage.getItem('pending_new_book_sync');
  if (pendingSyncJSON) {
    console.log("✅ Detected a new book requiring background sync after page load.");
    sessionStorage.removeItem('pending_new_book_sync');
    try {
      const pendingSync = JSON.parse(pendingSyncJSON);
      const { bookId, isNewBook } = pendingSync;
      if (bookId && isNewBook) {
        console.log("🚀 Kicking off background sync and storing promise...");
        window.pendingBookSyncPromise = fireAndForgetSync(bookId, isNewBook, pendingSync);
      }
    } catch (error) {
      console.error("❌ Failed to handle pending book sync:", error);
      window.pendingBookSyncPromise = null;
    }
  }
}

// This is the main entry point for a fresh page load.
document.addEventListener("DOMContentLoaded", async () => {
  console.log("✅ DOM is ready. Starting full page initialization...");

  handlePendingNewBookSync();
  await openDatabase();
  console.log("✅ IndexedDB initialized.");

  // This now works perfectly because the server sets the attribute on the body.
  const pageType = document.body.getAttribute("data-page");

  if (pageType === "reader") {
    // initializeReaderView can now safely use the 'book' variable
    // because app.js was guaranteed to run first.
    await initializeReaderView();
  } else if (pageType === "home") {
    initializeHomepage();
  }
});