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
// ✅ REMOVED: initializeFootnoteCitationListeners now managed by ButtonRegistry
import { setInitialBookSyncPromise, withPending, getInitialBookSyncPromise } from "./utilities/operationState.js";
import { generateTableOfContents } from "./components/toc.js";
import { attachMarkListeners } from "./hyperlights/index.js";
// ✅ REMOVED: TogglePerimeterButtons now managed exclusively by ButtonRegistry
// import TogglePerimeterButtons from "./components/togglePerimeterButtons.js";
import { showNavigationLoading, hideNavigationLoading } from "./scrolling.js";
import { pendingFirstChunkLoadedPromise } from "./initializePage.js";
import { initializeUserProfileEditor } from "./components/userProfileEditor.js";
import { initializeUserProfilePage } from "./components/userProfilePage.js";
import { initializeLogoNav } from "./components/logoNavToggle.js";

// ═════════════════════════════════════════════════════════════════════
// PROGRESS BAR CONTROL - DELEGATED TO PROGRESSOVERLAYCONDUCTOR
// ═════════════════════════════════════════════════════════════════════
// LEGACY: These functions used to directly manipulate DOM, now delegate to Conductor
// This ensures all overlay management goes through the centralized state machine

export async function updatePageLoadProgress(percent, message = null) {
  console.log(`📊 [LEGACY] updatePageLoadProgress called (${percent}%, ${message}) - delegating to ProgressOverlayConductor`);

  // Delegate to the new centralized system
  const { ProgressOverlayConductor } = await import('./navigation/ProgressOverlayConductor.js');
  ProgressOverlayConductor.updateProgress(percent, message);
}

export async function hidePageLoadProgress() {
  console.log(`📊 [LEGACY] hidePageLoadProgress called - delegating to ProgressOverlayConductor`);

  // Delegate to the new centralized system
  const { ProgressOverlayConductor } = await import('./navigation/ProgressOverlayConductor.js');
  return await ProgressOverlayConductor.hide();
}

// ✅ REMOVED: TogglePerimeterButtons instance creation moved to ButtonRegistry
// OLD CODE (caused conflict with ButtonRegistry):
// export const togglePerimeterButtons = new TogglePerimeterButtons({...});
// togglePerimeterButtons.init();
// NOW: ButtonRegistry handles initialization via registerComponents.js

function handlePendingNewBookSync() {
  const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
  if (pendingSyncJSON) {
    // Ensure overlay is definitely hidden for new book creation
    const overlay = document.getElementById('initial-navigation-overlay');
    if (overlay) {
      overlay.style.display = 'none';
    }

    // Don't remove sessionStorage here - let permission checks work until sync completes
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
          // Clean up sessionStorage after sync completes (success or failure)
          sessionStorage.removeItem("pending_new_book_sync");
          // Also, ensure the promise is cleared from the state manager when done.
          setInitialBookSyncPromise(null);
        });

        setInitialBookSyncPromise(syncPromise);
      } else {
        // Not a valid new book, clean up immediately
        sessionStorage.removeItem("pending_new_book_sync");
      }
    } catch (error) {
      log.error("Failed to handle pending book sync", "readerDOMContentLoaded.js", error);
      // Clean up on error
      sessionStorage.removeItem("pending_new_book_sync");
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
  const { glowCloudGreen, glowCloudRed } = await import('./components/editIndicator.js');
  initializeDatabaseModules({
    book,
    withPending,
    clearRedoHistory,
    getInitialBookSyncPromise,
    glowCloudGreen,
    glowCloudRed,
  });
  log.init("Database modules initialized", "readerDOMContentLoaded.js");

  // ✅ UNIFIED: ALL page types go through NavigationManager for consistent initialization
  // NavigationManager handles ALL initialization including ButtonRegistry
  const { NavigationManager } = await import('./navigation/NavigationManager.js');
  await NavigationManager.navigate('fresh-page-load');

  // Page-specific initialization after NavigationManager completes
  // Note: footnoteCitationListeners now handled by ButtonRegistry
  if (pageType === "user") {
    // User-specific components (in addition to what NavigationManager initialized)
    initializeUserProfilePage();
  }

  // Note: The following are now handled by NavigationManager → universalPageInitializer → ButtonRegistry:
  // - initializeHomepage() (for home/user pages)
  // - initializeLogoNav() (all pages)
  // - initializeUserProfileEditor() (user pages)
  // - All ButtonRegistry components (togglePerimeterButtons, userContainer, etc.)
});