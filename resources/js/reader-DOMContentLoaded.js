// In resources/js/reader-DOMContentLoaded.js

// =================================================================
// THE KEY FIX: Import app.js first to set up initial state.
// This line ensures the 'book' variable is defined before anything else runs.
import { book } from "./app.js";
// =================================================================

import { openDatabase } from "./cache-indexedDB.js";
import { fireAndForgetSync } from "./createNewBook.js";
import { initializeReaderView } from "./viewManager.js";
import { initializeHomepage } from "./homepage.js";
// ✅ This import is correct. We just need to use it.
import { setInitialBookSyncPromise } from "./operationState.js";
import NavButtons from "./nav-buttons.js";

export const navButtons = new NavButtons({
  elementIds: [
    "nav-buttons",
    "logoContainer",
    "topRightContainer",
    "userButtonContainer",
  ],
  tapThreshold: 15,
});

function handlePendingNewBookSync() {
  const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
  if (pendingSyncJSON) {
    console.log(
      "✅ Detected a new book requiring background sync after page load.",
    );
    sessionStorage.removeItem("pending_new_book_sync");
    try {
      const pendingSync = JSON.parse(pendingSyncJSON);
      const { bookId, isNewBook } = pendingSync;
      if (bookId && isNewBook) {
        console.log("🚀 Kicking off background sync and storing promise...");

        // ✅ THE FIX: Use your state manager instead of the window property.
        const syncPromise = fireAndForgetSync(
          bookId,
          isNewBook,
          pendingSync,
        ).finally(() => {
          // Also, ensure the promise is cleared from the state manager when done.
          console.log(
            "SYNC STATE: Initial book sync promise has been resolved/cleared.",
          );
          setInitialBookSyncPromise(null);
        });

        setInitialBookSyncPromise(syncPromise);
      }
    } catch (error) {
      console.error("❌ Failed to handle pending book sync:", error);
      // Ensure the promise is cleared on error too.
      setInitialBookSyncPromise(null);
    }
  }
}

// This part of your code is already correct and does not need to change.
document.addEventListener("DOMContentLoaded", async () => {
  console.log("✅ DOM is ready. Starting full page initialization...");

  handlePendingNewBookSync();
  await openDatabase();
  console.log("✅ IndexedDB initialized.");

  const pageType = document.body.getAttribute("data-page");

  if (pageType === "reader") {
    await initializeReaderView();
  } else if (pageType === "home") {
    initializeHomepage();
  }
});