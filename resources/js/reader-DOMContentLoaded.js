import { openDatabase } from "./cache-indexedDB.js";
import { fireAndForgetSync } from './createNewBook.js';
// Import our new, centralized initializer.
import { initializeReaderView } from './viewInitializers.js';
import { book } from './app.js'; // We need this to check the page type
import { initializeHomepage } from './homepage.js';

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

  const pageType = document.body.getAttribute("data-page");

  if (pageType === "reader") {
    await initializeReaderView();
  } else if (pageType === "home") {
    // ✅ Just call the single, clean homepage initializer.
    initializeHomepage();
  }
});