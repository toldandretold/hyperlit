// In resources/js/readerDOMContentLoaded.js

// =================================================================
// THE KEY FIX: Import app.js first to set up initial state.
// This line ensures the 'book' variable is defined before anything else runs.
import { book } from "./app.js";
// =================================================================

import { log } from "./utilities/logger.js";
import { openDatabase, initializeDatabaseModules } from "./indexedDB/index.js";
import { fireAndForgetSync } from "./createNewBook.js";
import { universalPageInitializer } from "./viewManager.js";
import { initializeHomepage } from "./homepage.js";
import { initializeFootnoteCitationListeners } from "./footnotesCitations.js";
// ✅ This import is correct. We just need to use it.
import { setInitialBookSyncPromise, withPending, getInitialBookSyncPromise } from "./utilities/operationState.js";
import { generateTableOfContents } from "./components/toc.js";
import { attachMarkListeners } from "./hyperlights/index.js";
import TogglePerimeterButtons from "./components/togglePerimeterButtons.js";
import { showNavigationLoading, hideNavigationLoading } from "./scrolling.js";
import { pendingFirstChunkLoadedPromise } from "./initializePage.js";
import { initializeUserProfileEditor } from "./components/userProfileEditor.js";
import { initializeLogoNav } from "./components/logoNavToggle.js";

// Progress bar control functions
export function updatePageLoadProgress(percent, message = null) {
  const overlay = document.getElementById('initial-navigation-overlay');
  const progressBar = document.getElementById('page-load-progress-bar');
  const progressText = document.getElementById('page-load-progress-text');
  const progressDetails = document.getElementById('page-load-progress-details');

  // ✅ Make the overlay visible whenever progress is updated.
  if (overlay) {
    overlay.style.display = 'block';
  }
  
  if (progressBar) {
    // Ensure progress never goes below 5% so we always see some color
    const adjustedPercent = Math.max(5, percent);
    progressBar.style.width = adjustedPercent + '%';
  }
  if (progressText) {
    progressText.textContent = `Loading... ${Math.round(percent)}%`;
  }
  if (message && progressDetails) {
    progressDetails.textContent = message;
  }
}

export async function hidePageLoadProgress() {
  // Delegate to ProgressOverlayEnactor for consistent hiding
  const { ProgressOverlayEnactor } = await import('./navigation/ProgressOverlayEnactor.js');
  return await ProgressOverlayEnactor.hide();
}

export const togglePerimeterButtons = new TogglePerimeterButtons({
  elementIds: [
    "bottom-right-buttons",
    "logoNavWrapper",
    "topRightContainer",
    "userButtonContainer",
  ],
  tapThreshold: 15,
});

// Initialize the perimeter buttons event listeners immediately
togglePerimeterButtons.init();

function handlePendingNewBookSync() {
  const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
  if (pendingSyncJSON) {
    // Ensure overlay is definitely hidden for new book creation
    const overlay = document.getElementById('initial-navigation-overlay');
    if (overlay) {
      overlay.style.display = 'none';
    }

    sessionStorage.removeItem("pending_new_book_sync");
    try {
      const pendingSync = JSON.parse(pendingSyncJSON);
      const { bookId, isNewBook } = pendingSync;
      if (bookId && isNewBook) {
        // ✅ THE FIX: Use your state manager instead of the window property.
        const syncPromise = fireAndForgetSync(
          bookId,
          isNewBook,
          pendingSync,
        ).finally(() => {
          // Also, ensure the promise is cleared from the state manager when done.
          setInitialBookSyncPromise(null);
        });

        setInitialBookSyncPromise(syncPromise);
      }
    } catch (error) {
      log.error("Failed to handle pending book sync", "readerDOMContentLoaded.js", error);
      // Ensure the promise is cleared on error too.
      setInitialBookSyncPromise(null);
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  log.init("DOM ready", "readerDOMContentLoaded.js");

  const pageType = document.body.getAttribute("data-page");

  // Check if this is a new book creation scenario
  const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
  const isNewBookCreation = !!pendingSyncJSON;

  handlePendingNewBookSync();
  await openDatabase();
  log.init("IndexedDB initialized", "readerDOMContentLoaded.js");

  // Initialize database modules with dependencies
  const { clearRedoHistory } = await import('./historyManager.js');
  const { showTick, showError } = await import('./components/editIndicator.js');
  initializeDatabaseModules({
    book,
    withPending,
    clearRedoHistory,
    getInitialBookSyncPromise,
    showTick,
    showError,
  });
  log.init("Database modules initialized", "readerDOMContentLoaded.js");

  if (pageType === "reader") {
    // ✅ Delegate fully to the new navigation system
    // NavigationManager handles ALL initialization including progress completion
    const { NavigationManager } = await import('./navigation/NavigationManager.js');
    await NavigationManager.handleFreshPageLoad();

    // Initialize footnote and citation click listeners after page loads
    initializeFootnoteCitationListeners();

    // Note: Progress hiding is now handled by universalPageInitializer in viewManager.js
    // No need for duplicate cleanup here

  } else if (pageType === "home") {
    await initializeHomepage();
  } else if (pageType === "user") {
    // User pages use same initialization as homepage (same structure)
    await initializeHomepage();
    // Initialize user profile editor (title and bio fields)
    await initializeUserProfileEditor();
  }

  // Initialize logo navigation toggle on all pages
  initializeLogoNav();
});