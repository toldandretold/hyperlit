

import { book, setCurrentBook } from "./app.js";
import { getCurrentUser, getAnonymousToken } from "./utilities/auth.js";
import { checkEditPermissionsAndUpdateUI } from "./components/editButton.js";

// ✅ Lazy-loaded edit modules (only loaded when editing)
// import { stopObserving } from "./divEditor/index.js";
// import { initEditToolbar, destroyEditToolbar } from "./editToolbar";
import { restoreScrollPosition, restoreNavigationOverlayIfNeeded, showNavigationLoading, hideNavigationLoading } from "./scrolling.js";
import { attachMarkListeners, initializeHighlightManager } from "./hyperlights/index.js";
import { initializeHighlightingControls } from "./hyperlights/selection.js";
import { initializeHypercitingControls } from "./hypercites/index.js";
import { initializeBroadcastListener } from "./utilities/BroadcastListener.js";
import { setupUnloadSync } from "./indexedDB/index.js";
import { generateTableOfContents, destroyTocManager, initializeTocManager } from "./components/toc.js";
import { KeyboardManager } from "./keyboardManager.js";
import {
  initializeEditButtonListeners,
  updateEditButtonVisibility,
  handleAutoEdit,
  enforceEditableState
} from "./components/editButton.js";
import { initializeSourceButtonListener } from "./components/sourceButton.js";
import {
  initializeSelectionHandler,
  destroySelectionHandler,
} from "./utilities/selectionHandler.js";
import { SelectionDeletionHandler } from "./utilities/selectionDelete.js";
import {
  loadHyperText,
  pendingFirstChunkLoadedPromise,
  resolveFirstChunkPromise,
  resetCurrentLazyLoader
} from "./initializePage.js";
import { closeHyperlitContainer } from './hyperlitContainer/index.js';

// State management and cleanup are correct.
let activeKeyboardManager = null;
let activeSelectionDeletionHandler = null;

// Track when this page was loaded to compare with cache invalidation timestamp
let pageLoadTimestamp = null;

// Helper function to get current auth state
async function getCurrentAuthState() {
  try {
    const currentUser = await getCurrentUser();
    const currentToken = await getAnonymousToken();
    
    return {
      isLoggedIn: !!currentUser,
      userId: currentUser ? (currentUser.name || currentUser.username || currentUser.email) : null,
      anonymousToken: currentToken
    };
  } catch (error) {
    console.error("❌ Error getting auth state:", error);
    return null;
  }
}

// Note: Cache invalidation functions removed as they may be unnecessary for SPA navigation

// Note: refreshHighlightsWithCurrentAuth function removed as it was unused

// Handle page restoration from browser cache (bfcache) - critical for mobile and desktop
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    console.log("🔄 Page restored from bfcache - reinitializing interactive features");
    
    // Sync SPA history state with bfcache restored page
    syncHistoryStateAfterBfcache();
    
    const pageType = document.body.getAttribute("data-page");
    
    // ✅ EXPANDED: Handle both reader pages AND homepage with reader content
    const hasReaderContent = pageType === "reader" || document.querySelector('.main-content, .book-content');
    
    if (hasReaderContent) {
      // Small delay to ensure DOM is fully restored
      setTimeout(async () => {
        try {
          console.log("🔧 Checking if cache invalidation required after browser navigation...");
          
          // Just ensure interactive features are working
          await checkEditPermissionsAndUpdateUI();
          
        } catch (error) {
          console.error("❌ Error handling browser navigation:", error);
        }
      }, 200);
    }
  }
});

export async function cleanupReaderView() {
  console.log("🧹 Cleaning up previous reader view...");

  // Close any open containers before destroying the view
  closeHyperlitContainer();

  // SPA TRANSITION FIX: Do not remove the navigation overlay here.
  // It is shown just before the transition and must persist.
  /*
  // Remove any navigation overlays that might be blocking button clicks
  const navigationOverlays = document.querySelectorAll('.navigation-overlay');
  navigationOverlays.forEach(overlay => {
    console.log("🎯 Removing leftover navigation overlay:", overlay);
    overlay.remove();
  });
  
  // Also ensure initial overlay is hidden
  const initialOverlay = document.getElementById('initial-navigation-overlay');
  if (initialOverlay) {
    initialOverlay.style.display = 'none';
    console.log("🎯 Hidden initial navigation overlay");
  }
  */

  // Clean up global event handlers via LinkNavigationHandler
  const { LinkNavigationHandler } = await import('./navigation/LinkNavigationHandler.js');
  LinkNavigationHandler.removeGlobalHandlers();

  if (activeKeyboardManager) {
    activeKeyboardManager.destroy();
    activeKeyboardManager = null;
  }
  if (activeSelectionDeletionHandler) {
    activeSelectionDeletionHandler.destroy();
    activeSelectionDeletionHandler = null;
  }

  // ✅ Dynamically import edit modules only if they were loaded
  try {
    const { destroyEditToolbar } = await import('./editToolbar/index.js');
    destroyEditToolbar();
  } catch (e) {
    // Module not loaded yet, nothing to destroy
  }

  try {
    const { stopObserving } = await import('./divEditor/index.js');
    stopObserving();
  } catch (e) {
    // Module not loaded yet, nothing to stop
  }

  destroySelectionHandler();
  destroyTocManager();
}

// ============================================================================
// LEGACY COMPATIBILITY LAYER
// These functions maintain the existing API but route to the new navigation system
// ============================================================================

export async function initializeImportedBook(bookId) {
  console.log(`🔥 DEBUG: initializeImportedBook CALLED for ${bookId} (via legacy API)`);
  
  try {
    const { NavigationManager } = await import('./navigation/NavigationManager.js');
    return await NavigationManager.handleImportBook({ bookId });
  } catch (error) {
    console.error('❌ Legacy initializeImportedBook routing failed, falling back to original:', error);
    // Fallback to original implementation below
  }
  
  // Original implementation as fallback
  console.log(`🔥 DEBUG: initializeImportedBook FALLBACK for ${bookId}`);
  try {
    console.log(`🎯 IMPORT: Starting initializeImportedBook for ${bookId}`);
    cleanupReaderView();

    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) throw new Error("Failed to fetch reader page HTML");
    const htmlString = await response.text();
    console.log(`🎯 IMPORT: Fetched HTML, length: ${htmlString.length} characters`);

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, "text/html");
    
    // 🔥 SIMPLE FIX: Remove the overlay from the fetched HTML before injecting it
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
      console.log('🎯 Import: Removed overlay from fetched HTML before injection');
    }
    
    document.body.innerHTML = newDoc.body.innerHTML;
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    // 🔥 CRITICAL FIX: Ensure data-page is set to "reader" for imported books
    document.body.setAttribute('data-page', 'reader');
    console.log('🎯 Import: Set data-page="reader" to ensure overlay logic works correctly');
    document.title = newDoc.title;

    
    // 🔥 CRITICAL FIX: Clean up the import flag after successful initialization
    const importFlag = sessionStorage.getItem('pending_import_book');
    if (importFlag) {
      sessionStorage.removeItem('pending_import_book');
      console.log('🎯 Import: Cleaned up pending_import_book flag after successful initialization');
    }

    // 🔥 ADD THIS: Reset contentEditable state after HTML injection
    const editableDiv = document.getElementById(bookId);
    if (editableDiv) {
      editableDiv.contentEditable = "false";
      console.log("🧹 Reset contentEditable after HTML injection");
    }

    enforceEditableState();

    setCurrentBook(bookId);
    history.pushState({}, "", `/${bookId}/edit?target=1`);

    await initializeImportedReaderView(bookId);

    console.log("🎯 Enabling edit mode for imported book");
    const { enableEditMode } = await import('./components/editButton.js');
    await enableEditMode(null, false);
    
    history.replaceState({}, "", `/${bookId}/edit?target=1&edit=1`);

  } catch (error) {
    console.error("❌ Imported book initialization failed:", error);
    window.location.href = `/${bookId}/edit?target=1`;
  }
}

export async function initializeImportedReaderView(bookId) {
  console.log(`🚀 Initializing imported reader view for: ${bookId}`);

  // 🔥 IMMEDIATE FIX: Hide overlay right now
  const overlay = document.getElementById('initial-navigation-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.style.visibility = 'hidden';
    overlay.remove();
    console.log('🎯 FIXED: Overlay completely removed for imported book');
  }

  // ✅ Mark this as imported content with the specific book ID
  sessionStorage.setItem('imported_book_flag', bookId);

  // ✅ Resolve the first chunk promise since content is already in DOM
  console.log("✅ Imported book: Content already in DOM, resolving first chunk promise");
  resolveFirstChunkPromise();

  // ✅ Call the ACTUAL universalPageInitializer function 
  await universalPageInitializer();

  // ✅ NOW call handleAutoEdit since the page is fully initialized
  console.log("🎯 Checking for auto-edit after imported book initialization");
  import('./components/editButton.js').then(module => {
    module.handleAutoEdit();
  });
  
  console.log("✅ Imported book fully initialized via standard reader flow");
}

export async function transitionToReaderView(bookId, hash = '', progressCallback = null) {
  console.log(`🔥 DEBUG: transitionToReaderView CALLED for ${bookId} (via legacy API)`);
  
  try {
    const { NavigationManager } = await import('./navigation/NavigationManager.js');
    return await NavigationManager.transitionToReaderView(bookId, hash, progressCallback);
  } catch (error) {
    console.error('❌ Legacy transitionToReaderView routing failed, falling back to original:', error);
    // Fallback to original implementation below
  }
  
  // Original implementation as fallback
  console.log(`🔥 DEBUG: transitionToReaderView FALLBACK for ${bookId}`);
  try {
    cleanupReaderView();

    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) throw new Error("Failed to fetch reader page HTML");
    const htmlString = await response.text();

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, "text/html");

    // ✅ SPA TRANSITION REFACTOR: Instead of replacing the entire body,
    // we now only replace the content of the #page-wrapper element.
    // This is more efficient and preserves the navigation overlay.
    const pageWrapper = document.getElementById('page-wrapper');
    const newPageWrapper = newDoc.getElementById('page-wrapper');

    if (pageWrapper && newPageWrapper) {
      pageWrapper.innerHTML = newPageWrapper.innerHTML;
    } else {
      // Fallback to old method if wrappers aren't found
      console.warn("Could not find #page-wrapper, falling back to body replacement.");
      document.body.innerHTML = newDoc.body.innerHTML;
    }

    // Sync body attributes and title
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    document.title = newDoc.title;

    setCurrentBook(bookId);
    const newUrl = `/${bookId}/edit?target=1&edit=1${hash}`;
    history.pushState({}, "", newUrl);

    // Initialize the reader view and wait for content loading to complete
    await universalPageInitializer(progressCallback);
    
    // ✅ Additional safety: Wait for the first chunk promise to ensure content is ready
    try {
      const { pendingFirstChunkLoadedPromise } = await import('./initializePage.js');
      if (pendingFirstChunkLoadedPromise) {
        console.log(`🎯 TransitionToReader: Ensuring ${bookId} content is fully loaded`);
        await pendingFirstChunkLoadedPromise;
        console.log(`✅ TransitionToReader: ${bookId} content confirmed ready`);
      }
    } catch (error) {
      console.warn('Could not wait for first chunk promise in transitionToReaderView:', error);
    }
  } catch (error) {
    console.error("SPA Transition Failed:", error);
    window.location.href = `/${bookId}/edit?target=1&edit=1`;
  }
}

// Note: Global link handlers now managed by LinkNavigationHandler
// All click/visibility/focus/popstate handlers moved there

export async function universalPageInitializer(progressCallback = null) {
  const currentBookId = book;
  console.log(`🚀 Universal Page Initializer for book: ${currentBookId}`);
  
  // Note: Cache invalidation checking removed for performance
  
  // Reset lazy loader to ensure we create a fresh one with the correct book ID
  resetCurrentLazyLoader();

  // 🎯 FIRST PRIORITY: Restore navigation overlay if it was active during page transition
  // Skip restore if overlay is already active from page load or if this is a new book creation
  const overlayAlreadyActive = document.querySelector('.navigation-overlay');
  const isNewBookCreation = sessionStorage.getItem('pending_new_book_sync');
  
  if (!overlayAlreadyActive && !isNewBookCreation) {
    restoreNavigationOverlayIfNeeded();
  } else if (isNewBookCreation) {
    console.log("✅ Skipping overlay restore for new book creation");
    // Double-ensure overlay is hidden for new book creation
    const overlay = document.getElementById('initial-navigation-overlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
      console.log('🎯 ViewManager: Ensured overlay is hidden for new book creation');
    }
  }

  enforceEditableState();

  // ✅ Check if this is an imported book
  const isImportedBook = sessionStorage.getItem('imported_book_initializing');
  if (isImportedBook) {
    console.log("📋 Imported book detected - using existing content");
  }

  // 🎯 CRITICAL: Detect page type BEFORE loading content to prevent race conditions
  const currentPageType = document.body.getAttribute('data-page');
  console.log(`🎯 Page type detected early: ${currentPageType}`);

  // Start loading content and wait for both content loading and DOM stabilization
  // ⚠️ IMPORTANT: Skip loadHyperText for home/user pages to prevent double-load race condition
  // For home/user pages, content is already loaded by initializeHomepageButtons() → transitionToBookContent()
  let loadPromise;
  if (currentPageType === 'home' || currentPageType === 'user') {
    console.log(`📄 Skipping loadHyperText for ${currentPageType} page (content already loaded by homepage system)`);
    loadPromise = Promise.resolve(); // No-op promise
  } else {
    console.log(`📖 Loading content for ${currentPageType} page`);
    loadPromise = loadHyperText(currentBookId, progressCallback);
  }

  // Wait for DOM to be properly stable before initializing UI components
  const { waitForLayoutStabilization } = await import('./domReadiness.js');

  // Wait for both content loading and layout stabilization to complete
  await Promise.all([loadPromise, waitForLayoutStabilization()]);

  console.log("✅ DOM settled. Initializing static UI components...");
    // Use the persistent TogglePerimeterButtons instance from readerDOMContentLoaded.js
    import('./readerDOMContentLoaded.js').then(module => {
      if (module.togglePerimeterButtons) {
        console.log("🔍 TogglePerimeterButtons before destroy - isInitialized:", module.togglePerimeterButtons.isInitialized);
        // Always destroy and reinitialize to ensure clean state after DOM changes
        module.togglePerimeterButtons.destroy();
        console.log("🔍 TogglePerimeterButtons after destroy - isInitialized:", module.togglePerimeterButtons.isInitialized);
        module.togglePerimeterButtons.rebindElements();
        console.log("🔍 TogglePerimeterButtons calling init() - isInitialized:", module.togglePerimeterButtons.isInitialized);
        module.togglePerimeterButtons.init();
        console.log("🔍 TogglePerimeterButtons after init() - isInitialized:", module.togglePerimeterButtons.isInitialized);
        module.togglePerimeterButtons.updatePosition();
        console.log("✅ Reinitialized TogglePerimeterButtons instance for universalPageInitializer");
      }
    });

    // Initialize components that work on both page types
    console.log("🔧 Initializing universal components...");
    await initializeUniversalComponents(currentPageType);

    // For homepage and user pages, skip reader-specific initialization
    // Content loading is handled by initializeHomepageButtons() for these page types
    if (currentPageType === 'home' || currentPageType === 'user') {
      console.log(`🏠 ${currentPageType} page initialization complete, skipping reader-specific components`);
      return; // Exit early - everything is handled by homepage/user page system
    }
    
    // Initialize ALL components for both homepage and reader pages
    // Components will handle their own conditional logic internally based on DOM availability
    console.log("🔧 Initializing all components for SPA compatibility...");
    initializeEditButtonListeners();
    initializeSourceButtonListener();
    updateEditButtonVisibility(currentBookId);
    initializeHighlightManager();
    initializeHighlightingControls(currentBookId);
    initializeHypercitingControls(currentBookId);
    initializeSelectionHandler();
    
    // Initialize user profile page functionality if user owns this book
    const { getCurrentUser } = await import('./utilities/auth.js');
    const user = await getCurrentUser();
    console.log(`🔍 USER PROFILE CHECK: user=${user?.name || 'null'}, currentBookId=${currentBookId}`);
    if (user && user.name === currentBookId) {
      const { initializeUserProfilePage } = await import('./components/userProfilePage.js');
      initializeUserProfilePage();
      console.log("✅ User profile page functionality initialized");
    } else {
      console.log(`❌ USER PROFILE NOT INITIALIZED: user.name="${user?.name}" !== currentBookId="${currentBookId}"`);
    }
    
    // Initialize SelectionDeletionHandler for handling selection deletions
    const editorContainer = document.querySelector('.main-content');
    if (editorContainer) {
      activeSelectionDeletionHandler = new SelectionDeletionHandler(editorContainer, {
        onDeleted: (nodeId) => {
          console.log(`✅ SelectionDeletionHandler: Node ${nodeId} deleted`);
        }
      });
      console.log("✅ SelectionDeletionHandler initialized");
    } else {
      console.log(`ℹ️ No .main-content found for SelectionDeletionHandler (page type: ${currentPageType})`);
    }
    
    // ✅ Dynamically import edit toolbar only when needed
    const { initEditToolbar } = await import('./editToolbar/index.js');
    initEditToolbar({
      toolbarId: "edit-toolbar",
      editableSelector: ".main-content[contenteditable='true']",
      currentBookId: currentBookId,
    });

  await loadPromise;
  console.log("✅ Content loading process complete.");

  activeKeyboardManager = new KeyboardManager();
  window.addEventListener("beforeunload", () => {
    if (activeKeyboardManager) activeKeyboardManager.destroy();
  });
  restoreScrollPosition();
  attachMarkListeners();
  // Use the new LinkNavigationHandler instead of inline logic
  const { LinkNavigationHandler } = await import('./navigation/LinkNavigationHandler.js');
  LinkNavigationHandler.attachGlobalLinkClickHandler();
  initializeBroadcastListener();
  setupUnloadSync();
  initializeTocManager();
  
  // ✅ CRITICAL: Check auth state and update edit button permissions after reader initialization
  await checkEditPermissionsAndUpdateUI();
  console.log("✅ Auth state checked and edit permissions updated in reader view");
  
  // 🔥 Initialize footnote and citation listeners AFTER content loads
  // This ensures the DOM elements exist before we attach listeners
  setTimeout(async () => {
    const { initializeFootnoteCitationListeners } = await import('./footnotesCitations.js');
    initializeFootnoteCitationListeners();
    console.log("✅ Footnote and citation listeners initialized after content load");
    
    // 🔥 CRITICAL: Rebind the reference container manager after SPA transitions
    // The ContainerManager needs fresh DOM references after HTML replacement
    const { refManager } = await import('./footnotesCitations.js');
    if (refManager && refManager.rebindElements) {
      refManager.rebindElements();
      console.log("✅ Reference container manager rebound after content load");
    }

    const { hyperlitManager } = await import('./hyperlitContainer/index.js');
    if (hyperlitManager && hyperlitManager.rebindElements) {
        hyperlitManager.rebindElements();
        console.log("✅ Hyperlit container manager rebound after content load");
    }

  }, 500);

  // ✅ CRITICAL: Complete the progress bar to 100%
  // Note: We don't hide the overlay here - let the navigation pathway handle that
  // to avoid race conditions with multiple hide calls
  if (progressCallback) {
    progressCallback(100, "Complete");
    console.log("✅ Progress callback completed with 100%");
  }

}

/**
 * Sync SPA history state when page is restored from bfcache
 * This prevents history stack confusion and back/forward loops
 */
function syncHistoryStateAfterBfcache() {
  try {
    console.log("🔄 Syncing SPA history state after bfcache restoration");
    
    const currentUrl = window.location.href;
    const currentPath = window.location.pathname;
    const currentHash = window.location.hash;
    
    // Determine what type of page we're on
    const pageType = document.body.getAttribute('data-page');
    console.log(`🔄 bfcache restored page type: ${pageType}, URL: ${currentUrl}`);
    
    // Create a clean history state that matches the current page
    const cleanState = {
      timestamp: Date.now(),
      restoredFromBfcache: true,
      pageType: pageType
    };
    
    // If this is a reader page, add book transition metadata
    if (pageType === 'reader') {
      // Extract book ID from URL
      const pathSegments = currentPath.split('/').filter(Boolean);
      const bookId = pathSegments[0] || 'unknown';
      
      cleanState.bookTransition = {
        toBook: bookId,
        timestamp: Date.now(),
        method: 'bfcache-restore'
      };
      
      // If there's a hash, check if it's a hyperlit container
      if (currentHash) {
        const hashId = currentHash.substring(1);
        if (hashId.startsWith('HL_') || hashId.startsWith('hypercite_') || 
            hashId.startsWith('footnote_') || hashId.startsWith('citation_')) {
          
          // Create container state for the hash
          cleanState.hyperlitContainer = {
            contentTypes: [{
              type: hashId.startsWith('HL_') ? 'highlight' : 
                    hashId.startsWith('hypercite_') ? 'hypercite' :
                    hashId.startsWith('footnote_') ? 'footnote' : 'citation',
              [hashId.startsWith('HL_') ? 'highlightIds' : 
                hashId.startsWith('hypercite_') ? 'hyperciteId' :
                hashId.startsWith('footnote_') ? 'elementId' : 'referenceId']: 
                hashId.startsWith('HL_') ? [hashId] : hashId
            }],
            timestamp: Date.now(),
            restoredFromBfcache: true
          };
          
          console.log(`🔄 Restored hyperlit container state for: ${hashId}`);
        }
      }
    }
    
    // Replace the current history state with the clean one
    // This ensures the back button works correctly after bfcache restoration
    history.replaceState(cleanState, '', currentUrl);
    
    console.log("✅ History state synchronized after bfcache restoration:", cleanState);
    
  } catch (error) {
    console.error("❌ Error syncing history state after bfcache:", error);
  }
}

/**
 * Initialize components that work on both homepage and reader pages
 */
async function initializeUniversalComponents(pageType) {
  try {
    console.log(`🔧 Initializing universal components for page type: ${pageType}`);
    
    // SPA Transition Fix: If the transition pathway has already initialized
    // containers, skip doing it again here to prevent state corruption.
    if (window.containersAlreadyInitialized) {
        console.log('🏠 [SPA] Skipping container/homepage initialization as it was handled by the transition.');
    } else {
        // Initialize user container - works on both homepage and reader pages
        try {
          // Import the user container module to trigger its initialization
          await import('./components/userContainer.js');
          console.log('✅ User container initialized for universal access');
        } catch (error) {
          console.warn('Could not initialize user container:', error);
        }
        
        // Initialize homepage-specific components if we're on the homepage
        if (pageType === 'home') {
          try {
            console.log('🏠 Initializing homepage-specific components...');
            const { initializeHomepage } = await import('./homepage.js');
            await initializeHomepage();
            console.log('✅ Homepage components initialized successfully');
          } catch (error) {
            console.error('❌ Error initializing homepage components:', error);
          }
        }
    }
    
    // Add other universal components here that should work on both page types
    // For example: search functionality, theme switcher, etc.
    
  } catch (error) {
    console.error('❌ Error initializing universal components:', error);
  }
}


