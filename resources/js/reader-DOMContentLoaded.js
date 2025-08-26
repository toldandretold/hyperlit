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
import { showNavigationLoading, hideNavigationLoading } from "./scrolling.js";
import { pendingFirstChunkLoadedPromise } from "./initializePage.js";

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
    
    // Ensure overlay is definitely hidden for new book creation
    const overlay = document.getElementById('initial-navigation-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      console.log('🎯 Double-ensuring overlay is hidden for new book creation');
    }
    
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
  
  const pageType = document.body.getAttribute("data-page");

  // Check if this is a new book creation scenario
  const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
  const isNewBookCreation = !!pendingSyncJSON;
  
  // For new book creation, overlay is already hidden by blade template
  if (isNewBookCreation) {
    console.log("✅ New book creation detected - overlay already handled by blade template");
  } else if (pageType === "reader") {
    console.log("✅ Normal reader page load - overlay visible, will hide when content loads");
  }

  handlePendingNewBookSync();
  await openDatabase();
  console.log("✅ IndexedDB initialized.");

  if (pageType === "reader") {
    await initializeReaderView();
    
    // Hide overlay once content is fully loaded (only if we showed it)
    if (!isNewBookCreation) {
      try {
        await pendingFirstChunkLoadedPromise;
        console.log("✅ Content fully loaded, hiding overlay");
        hideNavigationLoading();
      } catch (error) {
        console.warn("⚠️ Content loading promise failed, hiding overlay anyway:", error);
        hideNavigationLoading();
      }
    } else {
      console.log("✅ New book creation - no overlay to hide");
    }
  } else if (pageType === "home") {
    initializeHomepage();
  }
});