// In resources/js/readerDOMContentLoaded.js

// =================================================================
// THE KEY FIX: Import app.js first to set up initial state.
// This line ensures the 'book' variable is defined before anything else runs.
import { book } from "../app.js";
// =================================================================

import { log } from "../utilities/logger";
import { openDatabase, initializeDatabaseModules } from "../indexedDB/index.js";
import { fireAndForgetSync } from "../SPA/createNewBook";
import { universalPageInitializer } from "../SPA/viewManager";
import { initializeHomepage } from "../components/homepage/homepage";
// ✅ REMOVED: initializeFootnoteCitationListeners now managed by ButtonRegistry
import { setInitialBookSyncPromise, withPending, getInitialBookSyncPromise } from "../utilities/operationState";
import { generateTableOfContents } from "../components/tocContainer/index";
import { attachMarkListeners } from "../hyperlights/index";
// ✅ REMOVED: TogglePerimeterButtons now managed exclusively by ButtonRegistry
// import TogglePerimeterButtons from "./components/togglePerimeterButtons.js";
import { showNavigationLoading, hideNavigationLoading } from "../scrolling/index";
import { pendingFirstChunkLoadedPromise } from "./firstChunkPromise";
import { initializeUserProfileEditor } from "../components/userProfile/userProfileEditor";
import { initializeUserProfilePage } from "../components/userProfile/userProfilePage";
import { initializeLogoNav } from "../components/logoNav/logoNav";

// ═════════════════════════════════════════════════════════════════════
// PROGRESS BAR CONTROL - DELEGATED TO PROGRESSOVERLAYCONDUCTOR
// ═════════════════════════════════════════════════════════════════════
// LEGACY: These functions used to directly manipulate DOM, now delegate to Conductor
// This ensures all overlay management goes through the centralized state machine

export async function updatePageLoadProgress(percent: number, message: any = null) {
  console.log(`📊 [LEGACY] updatePageLoadProgress called (${percent}%, ${message}) - delegating to ProgressOverlayConductor`);

  // Delegate to the new centralized system
  const { ProgressOverlayConductor } = await import('../SPA/navigation/ProgressOverlayConductor.js');
  ProgressOverlayConductor.updateProgress(percent, message);
}

export async function hidePageLoadProgress() {
  console.log(`📊 [LEGACY] hidePageLoadProgress called - delegating to ProgressOverlayConductor`);

  // Delegate to the new centralized system
  const { ProgressOverlayConductor } = await import('../SPA/navigation/ProgressOverlayConductor.js');
  return await ProgressOverlayConductor.hide();
}

// ✅ REMOVED: TogglePerimeterButtons instance creation moved to ButtonRegistry
// OLD CODE (caused conflict with ButtonRegistry):
// export const togglePerimeterButtons = new TogglePerimeterButtons({...});
// togglePerimeterButtons.init();
// NOW: ButtonRegistry handles initialization via registerComponents.ts

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
    } catch (error: any) {
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
  const { glowCloudGreen, glowCloudRed, glowCloudLocalSave } = await import('../components/cloudRef/editIndicator');
  initializeDatabaseModules({
    book,
    withPending,
    getInitialBookSyncPromise,
    glowCloudGreen,
    glowCloudRed,
    glowCloudLocalSave,
  } as any);
  log.init("Database modules initialized", "readerDOMContentLoaded.js");

  // Time machine: fetch historical data and store in IndexedDB BEFORE NavigationManager
  // runs loadHyperText, so it finds the data in cache and renders normally.
  if (pageType === 'timemachine') {
    const { initializeTimeMachine } = await import('./timeMachine');
    await initializeTimeMachine();
  }

  // ✅ UNIFIED: ALL page types go through NavigationManager for consistent initialization
  // NavigationManager handles ALL initialization including ButtonRegistry
  const { NavigationManager } = await import('../SPA/navigation/NavigationManager.js');
  await NavigationManager.navigate('fresh-page-load');

  // If a vibe-convert job auto-applied a fix to this book, surface the Keep/Revert toast (driven by the
  // persisted vibe_review.json, so it shows even if the original toast was lost to navigation).
  if (book && pageType !== 'timemachine') {
    import('../conversion/feedbackToast.js')
      .then(m => m.checkPendingVibeReview(book))
      .catch(() => {});
  }

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
