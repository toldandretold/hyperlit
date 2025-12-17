
import { log, verbose } from './utilities/logger.js';
import { book, setCurrentBook } from "./app.js";
import { getCurrentUser, getAnonymousToken, initializeAuthBroadcastListener } from "./utilities/auth.js";
import { checkEditPermissionsAndUpdateUI } from "./components/editButton.js";

// ✅ ButtonRegistry - Centralized component initialization
import { buttonRegistry } from './utilities/buttonRegistry.js';
import { registerAllComponents } from './components/registerComponents.js';

// ✅ Register all UI components with ButtonRegistry
// This must happen at module load time before any initialization
registerAllComponents();

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
import { destroySettingsManager, initializeSettingsManager } from "./components/settingsContainer.js";
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
import { queueNodeForDeletion, queueNodeForSave } from "./divEditor/index.js";
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
    console.error("Error getting auth state:", error);
    return null;
  }
}

// Note: Cache invalidation functions removed as they may be unnecessary for SPA navigation

// Note: refreshHighlightsWithCurrentAuth function removed as it was unused

// Handle page restoration from browser cache (bfcache) - critical for mobile and desktop
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    verbose.init('Page restored from bfcache - reinitializing', 'viewManager.js');
    
    // Sync SPA history state with bfcache restored page
    syncHistoryStateAfterBfcache();
    
    const pageType = document.body.getAttribute("data-page");
    
    // ✅ EXPANDED: Handle both reader pages AND homepage with reader content
    const hasReaderContent = pageType === "reader" || document.querySelector('.main-content, .book-content');
    
    if (hasReaderContent) {
      // Small delay to ensure DOM is fully restored
      setTimeout(async () => {
        try {
          // Just ensure interactive features are working
          await checkEditPermissionsAndUpdateUI();

        } catch (error) {
          log.error('Error handling browser navigation', 'viewManager.js', error);
        }
      }, 200);
    }
  }
});

export async function cleanupReaderView() {
  verbose.init('Cleaning up previous reader view', 'viewManager.js');

  // Close any open containers before destroying the view
  closeHyperlitContainer();

  // SPA TRANSITION FIX: Do not remove the navigation overlay here.
  // It is shown just before the transition and must persist.

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

  // ✅ Clean up content-specific listeners (hyperlights, hypercites)
  try {
    const { cleanupHighlightingControls } = await import('./hyperlights/selection.js');
    cleanupHighlightingControls();
  } catch (e) {
    // Module not loaded yet, nothing to cleanup
  }

  try {
    const { cleanupUnderlineClickListeners } = await import('./hypercites/index.js');
    cleanupUnderlineClickListeners();
  } catch (e) {
    // Module not loaded yet, nothing to cleanup
  }

  try {
    const { destroyHyperlitManager } = await import('./hyperlitContainer/index.js');
    destroyHyperlitManager();
  } catch (e) {
    // Module not loaded yet, nothing to destroy
  }

  // ✅ NEW: Use ButtonRegistry for systematic cleanup
  // Destroys all registered components (toc, settings, edit, source, logo, etc.)
  buttonRegistry.destroyAll();
}



export async function universalPageInitializer(progressCallback = null) {
  const currentBookId = book;
  
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
    // Double-ensure overlay is hidden for new book creation
    const overlay = document.getElementById('initial-navigation-overlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
    }
  }

  enforceEditableState();

  // ✅ Check if this is an imported book
  const isImportedBook = sessionStorage.getItem('imported_book_initializing');

  // 🎯 CRITICAL: Detect page type BEFORE loading content to prevent race conditions
  const currentPageType = document.body.getAttribute('data-page');
  log.init(`Page type: ${currentPageType}`, 'viewManager.js');

  // Start loading content and wait for both content loading and DOM stabilization
  // ⚠️ IMPORTANT: Skip loadHyperText for home/user pages to prevent double-load race condition
  // For home/user pages, content is already loaded by initializeHomepageButtons() → transitionToBookContent()
  let loadPromise;
  if (currentPageType === 'home' || currentPageType === 'user') {
    loadPromise = Promise.resolve(); // No-op promise
  } else {
    loadPromise = loadHyperText(currentBookId, progressCallback);
  }

  // Wait for DOM to be properly stable before initializing UI components
  const { waitForLayoutStabilization } = await import('./domReadiness.js');

  // Wait for both content loading and layout stabilization to complete
  await Promise.all([loadPromise, waitForLayoutStabilization()]);

  verbose.init('DOM settled. Initializing static UI components', 'viewManager.js');

  // ✅ REMOVED: Manual TogglePerimeterButtons management
  // OLD CODE (conflicted with ButtonRegistry):
  // import('./readerDOMContentLoaded.js').then(module => {
  //   module.togglePerimeterButtons.destroy();
  //   module.togglePerimeterButtons.rebindElements();
  //   module.togglePerimeterButtons.init();
  // });
  // NOW: ButtonRegistry handles this automatically via initializeAll()

  // Initialize components that work on both page types
  log.init('Universal components initialized', 'viewManager.js');
    await initializeUniversalComponents(currentPageType);

    // 🔧 CRITICAL: Attach global handlers (popstate/visibility, focus) for ALL page types
    // This must happen BEFORE early return for home/user pages
    const { LinkNavigationHandler } = await import('./navigation/LinkNavigationHandler.js');
    LinkNavigationHandler.attachGlobalLinkClickHandler();
    verbose.init('Navigation handlers attached', '/navigation/LinkNavigationHandler.js');

    // Initialize cross-tab auth sync for ALL page types
    initializeAuthBroadcastListener();

    // For homepage and user pages, skip reader-specific initialization
    // Content loading is handled by initializeHomepageButtons() for these page types
    if (currentPageType === 'home' || currentPageType === 'user') {
      return; // Exit early - everything is handled by homepage/user page system
    }

    // ✅ Initialize ALL registered components for reader page
    await buttonRegistry.initializeAll('reader');

    // Initialize reader-specific features not managed by ButtonRegistry
    updateEditButtonVisibility(currentBookId);
    initializeHighlightManager();
    initializeHighlightingControls(currentBookId);
    initializeHypercitingControls(currentBookId);
    initializeSelectionHandler();
    
    // Initialize user profile page functionality if user owns this book
    const { getCurrentUser } = await import('./utilities/auth.js');
    const user = await getCurrentUser();
    verbose.init(`User profile check: user=${user?.name || 'null'}, currentBookId=${currentBookId}`, 'viewManager.js');
    if (user && user.name === currentBookId) {
      const { initializeUserProfilePage } = await import('./components/userProfilePage.js');
      initializeUserProfilePage();
      verbose.init('User profile page functionality initialized', 'viewManager.js');
    }
    
    // Initialize SelectionDeletionHandler for handling selection deletions
    const editorContainer = document.querySelector('.main-content');
    if (editorContainer) {
      activeSelectionDeletionHandler = new SelectionDeletionHandler(editorContainer, {
        queueNodeForDeletion: queueNodeForDeletion,
        queueNodeForSave: queueNodeForSave
      });
      verbose.init('SelectionDeletionHandler initialized', 'viewManager.js');
    } else {
      verbose.init(`No .main-content found for SelectionDeletionHandler (page type: ${currentPageType})`, 'viewManager.js');
    }
    
    // ✅ Dynamically import edit toolbar only when needed
    const { initEditToolbar } = await import('./editToolbar/index.js');
    initEditToolbar({
      toolbarId: "edit-toolbar",
      editableSelector: ".main-content[contenteditable='true']",
      currentBookId: currentBookId,
    });

  await loadPromise;
  verbose.init('Content loading process complete', 'viewManager.js');

  activeKeyboardManager = new KeyboardManager();
  window.addEventListener("beforeunload", () => {
    if (activeKeyboardManager) activeKeyboardManager.destroy();
  });
  restoreScrollPosition();
  attachMarkListeners();

  // ✅ Attach hypercite click listeners after content loads
  const { attachUnderlineClickListeners } = await import('./hypercites/index.js');
  attachUnderlineClickListeners();

  // Note: LinkNavigationHandler.attachGlobalLinkClickHandler() now called earlier for all page types
  initializeBroadcastListener();
  setupUnloadSync();

  // ✅ NOTE: Component initialization (toc, settings, etc.) now handled by
  // buttonRegistry.initializeAll('reader') above - no duplicate calls needed

  // ✅ CRITICAL: Check auth state and update edit button permissions after reader initialization
  await checkEditPermissionsAndUpdateUI();
  verbose.init('Auth state checked and edit permissions updated in reader view', 'viewManager.js');
  
  // 🔥 Initialize footnote and citation listeners AFTER content loads
  // This ensures the DOM elements exist before we attach listeners
  setTimeout(async () => {
    const { initializeFootnoteCitationListeners } = await import('./footnotesCitations.js');
    initializeFootnoteCitationListeners();
    verbose.init('Footnote and citation listeners initialized after content load', 'viewManager.js');

    // 🔥 CRITICAL: Rebind the reference container manager after SPA transitions
    // The ContainerManager needs fresh DOM references after HTML replacement
    const { refManager } = await import('./footnotesCitations.js');
    if (refManager && refManager.rebindElements) {
      refManager.rebindElements();
      verbose.init('Reference container manager rebound after content load', 'viewManager.js');
    }

    const { hyperlitManager } = await import('./hyperlitContainer/index.js');
    if (hyperlitManager && hyperlitManager.rebindElements) {
        hyperlitManager.rebindElements();
        verbose.init('Hyperlit container manager rebound after content load', 'viewManager.js');
    }

  }, 500);

  // ✅ REMOVED: Don't call progressCallback(100) here
  // For SPA navigation: The navigation pathway handles completion/hiding
  // For fresh page loads: NavigationManager.navigate() hides the overlay after completion
  // Calling progress(100) here was causing the overlay to show at 100% AFTER being hidden

}

/**
 * Sync SPA history state when page is restored from bfcache
 * This prevents history stack confusion and back/forward loops
 */
function syncHistoryStateAfterBfcache() {
  try {
    verbose.init('Syncing SPA history state after bfcache restoration', 'viewManager.js');

    const currentUrl = window.location.href;
    const currentPath = window.location.pathname;
    const currentHash = window.location.hash;

    // Determine what type of page we're on
    const pageType = document.body.getAttribute('data-page');
    verbose.init(`bfcache restored page type: ${pageType}, URL: ${currentUrl}`, 'viewManager.js');
    
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

          verbose.init(`Restored hyperlit container state for: ${hashId}`, 'viewManager.js');
        }
      }
    }

    // Replace the current history state with the clean one
    // This ensures the back button works correctly after bfcache restoration
    history.replaceState(cleanState, '', currentUrl);

    verbose.init('History state synchronized after bfcache restoration', 'viewManager.js');
    
  } catch (error) {
    console.error("Error syncing history state after bfcache:", error);
  }
}

/**
 * Initialize components that work on both homepage and reader pages
 */
async function initializeUniversalComponents(pageType) {
  try {
    verbose.init(`Initializing universal components for page type: ${pageType}`, 'viewManager.js');

    // ✅ Initialize all registered components for this page type (home/user)
    // Components registered for 'home' and 'user' page types will be initialized
    if (pageType === 'home' || pageType === 'user') {
      await buttonRegistry.initializeAll(pageType);
    }

    // SPA Transition Fix: If the transition pathway has already initialized
    // containers, skip doing it again here to prevent state corruption.
    if (window.containersAlreadyInitialized) {
        verbose.init('[SPA] Skipping container/homepage initialization as it was handled by the transition', 'viewManager.js');
    } else {
        // ✅ NOTE: userContainer initialization now handled by ButtonRegistry above
        // Legacy manual initialization removed to prevent duplicates

        // Initialize homepage-specific components for both home AND user pages
        // User pages share the same structure as home pages (book grid, etc.)
        if (pageType === 'home' || pageType === 'user') {
          try {
            verbose.init(`Initializing homepage components for ${pageType} page`, 'viewManager.js');
            const { initializeHomepage } = await import('./homepage.js');
            await initializeHomepage();
            verbose.init('Homepage components initialized successfully', 'viewManager.js');
          } catch (error) {
            console.error('Error initializing homepage components:', error);
          }
        }

        // Initialize user profile editor ONLY for user pages
        if (pageType === 'user') {
          try {
            verbose.init('Initializing user profile editor', 'viewManager.js');
            const { initializeUserProfileEditor } = await import('./components/userProfileEditor.js');
            await initializeUserProfileEditor();
            verbose.init('User profile editor initialized successfully', 'viewManager.js');
          } catch (error) {
            console.error('Error initializing user profile editor:', error);
          }
        }
    }

    // Add other universal components here that should work on both page types
    // For example: search functionality, theme switcher, etc.

  } catch (error) {
    console.error('Error initializing universal components:', error);
  }
}


