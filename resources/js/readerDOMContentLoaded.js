// In resources/js/readerDOMContentLoaded.js

// =================================================================
// THE KEY FIX: Import app.js first to set up initial state.
// This line ensures the 'book' variable is defined before anything else runs.
import { book } from "./app.js";
// =================================================================

import { openDatabase } from "./indexedDB.js";
import { fireAndForgetSync } from "./createNewBook.js";
import { universalPageInitializer } from "./viewManager.js";
import { initializeHomepage } from "./homepage.js";
import { initializeFootnoteCitationListeners } from "./footnotesCitations.js";
// ✅ This import is correct. We just need to use it.
import { setInitialBookSyncPromise } from "./utilities/operationState.js";
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

// Guard to prevent multiple simultaneous hide operations
let _isHidingProgress = false;

export async function hidePageLoadProgress() {
  // Prevent multiple simultaneous hide operations
  if (_isHidingProgress) {
    console.log('📊 hidePageLoadProgress: Already hiding, skipping duplicate call');
    return;
  }

  _isHidingProgress = true;

  try {
    const progressBar = document.getElementById('page-load-progress-bar');
    const progressText = document.getElementById('page-load-progress-text');
    const progressDetails = document.getElementById('page-load-progress-details');
    const overlay = document.getElementById('initial-navigation-overlay');

    // Always do the completion animation for visual satisfaction
    if (progressBar && overlay && overlay.style.display !== 'none') {
      const currentWidth = parseInt(progressBar.style.width) || 5;
    
    // Always hide the text elements before the final animation for clean visual
    if (progressText) progressText.style.opacity = '0';
    if (progressDetails) progressDetails.style.opacity = '0';
    
    // Always ensure we get a smooth animation to 100% regardless of current progress
    // If we're already at 100%, step back to create animation
    if (currentWidth >= 100) {
      progressBar.style.width = '90%';
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // If we're below 85%, step up to at least 85% to make a nice sweep
    else if (currentWidth < 85) {
      progressBar.style.width = '85%';
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Always shoot to 100% for the satisfying completion sweep
    progressBar.style.width = '100%';
    
      // Wait for the CSS transition to complete
      await new Promise(resolve => setTimeout(resolve, 400));
    }

    if (overlay) {
      overlay.style.display = 'none';
    }
  } finally {
    _isHidingProgress = false;
  }
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
    // ✅ Delegate fully to the new navigation system
    // NavigationManager handles ALL initialization including progress completion
    const { NavigationManager } = await import('./navigation/NavigationManager.js');
    await NavigationManager.handleFreshPageLoad();

    // Initialize footnote and citation click listeners after page loads
    initializeFootnoteCitationListeners();
    console.log("✅ Footnote and citation listeners initialized");

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
  console.log("✅ Logo navigation toggle initialized");
});