
import { log, verbose } from '../utilities/logger';
import { attachGlobalLinkClickHandler, removeGlobalHandlers } from './navigation/navigationRegistry';
import { book, setCurrentBook } from "../app";
import { getCurrentUser, getAnonymousToken, initializeAuthBroadcastListener, initializeAuthStateListener } from "../utilities/auth/index";
import { checkEditPermissionsAndUpdateUI } from "../components/editButton/index";

// ✅ ButtonRegistry - Centralized component initialization
import { buttonRegistry } from '../components/utilities/buttonRegistry';
import { registerAllComponents } from '../components/utilities/registerComponents';

// ✅ Register all UI components with ButtonRegistry
// This must happen at module load time before any initialization
registerAllComponents();

// ✅ Lazy-loaded edit modules (only loaded when editing)
// import { stopObserving } from "../divEditor/index";
// import { initEditToolbar, destroyEditToolbar } from "../editToolbar/index";
import { restoreScrollPosition, restoreNavigationOverlayIfNeeded, showNavigationLoading, hideNavigationLoading } from "../scrolling/index";
import { registerContainerActions } from "../hyperlitContainer/containerActions";

// hyperlights/hypercites are READER-ONLY interaction (highlight/hypercite click + selection toolbar +
// nav). They're loaded lazily inside the reader-only init block below (and the bfcache handler), so
// home/user pages never fetch them and they stay OUT of the eager bundle. Register the "open highlight"
// action as a LAZY WRAPPER so lower layers (scrolling) can call it via a static downward import without
// statically pulling hyperlights into the eager bundle (the import resolves on first click, by which
// time reader-init has warmed the chunk).
registerContainerActions({
  openHighlightById: (...args: any[]) => import("../hyperlights/index").then((m) => (m.openHighlightById as any)(...args)),
});
import { initializeBroadcastListener } from "../utilities/BroadcastListener";
import { setupUnloadSync } from "../indexedDB/index.js";
import { generateTableOfContents } from "../components/tocContainer/index";
import { destroyTocManager, initializeTocManager } from "../components/tocToggleButton/tocToggleButton";
import { destroySettingsManager, initializeSettingsManager } from "../components/settingsButton/settingsButton";
import { KeyboardManager } from "../components/utilities/keyboardManager";
import {
  initializeEditButtonListeners,
  updateEditButtonVisibility,
  enforceEditableState
} from "../components/editButton/index";
import { initializeSourceButtonListener } from "../components/cloudRef/cloudRefButton";
import {
  initializeSelectionHandler,
  destroySelectionHandler,
} from "../components/selectionHandler/selectionHandler";
// SelectionDeletionHandler + node-queue fns load lazily at reader-init (below) so this EAGER module
// never statically imports the divEditor (editor) chunk — keeping that chunk lazy.
import { loadHyperText } from "../pageLoad/loadHyperText";
import {
  pendingFirstChunkLoadedPromise,
  resolveFirstChunkPromise
} from "../pageLoad/firstChunkPromise";
import { resetCurrentLazyLoader } from "../pageLoad/lazyLoaderRegistry";
import { closeHyperlitContainer } from '../hyperlitContainer/index';

// State management and cleanup are correct.
let activeKeyboardManager: any = null;
let activeSelectionDeletionHandler: any = null;

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
window.addEventListener("pageshow", async (event) => {
  if (event.persisted) {
    verbose.init('Page restored from bfcache - reinitializing all components', 'viewManager.js');

    syncHistoryStateAfterBfcache();

    // Proactive IDB warm-up: iOS kills IDB connections during suspension.
    // Show a toast while we attempt to reconnect, with a refresh escape hatch.
    const { openDatabase } = await import('../indexedDB/core/connection');
    const { showIDBRecoveryToast, updateIDBRecoveryToast, hideIDBRecoveryToast } = await import('../indexedDB/core/recoveryToast');

    showIDBRecoveryToast();
    try {
      const db = await openDatabase();
      db.close();
      hideIDBRecoveryToast();
      verbose.init('IDB connection verified after bfcache restore', 'viewManager.js');
    } catch (e) {
      console.error('IDB reconnect failed after bfcache restore:', e);
      updateIDBRecoveryToast('Database unavailable — tap Refresh');
    }

    const pageType = document.body.getAttribute("data-page");
    const hasReaderContent = pageType === "reader" || document.querySelector('.main-content, .book-content');

    if (hasReaderContent) {
      // Small delay to ensure DOM is fully restored from bfcache
      setTimeout(async () => {
        try {
          // Reinitialize all ButtonRegistry components (TOC, footnotes, settings, etc.)
          // reinitializeAll = destroyAll() + initializeAll(), handles both destroyed and active states
          await buttonRegistry.reinitializeAll(pageType as any);

          // Rebind container managers that live outside ButtonRegistry
          const { hyperlitManager, initializeHyperlitManager } = await import('../hyperlitContainer/index');
          if (hyperlitManager?.rebindElements) {
            hyperlitManager.rebindElements();
          } else {
            initializeHyperlitManager();
          }

          await checkEditPermissionsAndUpdateUI();

          // Reinitialize highlighting/selection controls (not in ButtonRegistry). hyperlights/
          // hypercites are reader-only lazy chunks (this bfcache path only runs on reader pages).
          const [{ initializeHighlightingControls, cleanupHighlightingControls }, { initializeHypercitingControls, cleanupHypercitingControls }] =
            await Promise.all([import('../hyperlights/selectionToolbar'), import('../hypercites/index')]);
          cleanupHighlightingControls();
          initializeHighlightingControls(book);
          cleanupHypercitingControls();
          initializeHypercitingControls(book);
          destroySelectionHandler();
          initializeSelectionHandler();

        } catch (error) {
          log.error('Error reinitializing after bfcache restore', 'viewManager.js', error as any);
        }
      }, 200);
    }
  }
});

// Proactive IDB health check when tab becomes visible again.
// Catches iOS cases where IDB dies without bfcache (Safari can kill
// IDB connections during background suspension without event.persisted).
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;

  // Only probe on reader pages where editing can occur
  const pageType = document.body.getAttribute('data-page');
  if (pageType !== 'reader') return;

  try {
    const { openDatabase } = await import('../indexedDB/core/connection');
    const { reportIDBSuccess, reportIDBFailure, attemptRecovery } = await import('../indexedDB/core/healthMonitor');

    const db = await openDatabase();

    // Lightweight test transaction
    await new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('nodes', 'readonly');
        const store = tx.objectStore('nodes');
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
      } catch (e) {
        reject(e);
      }
    });

    db.close();
    reportIDBSuccess();
  } catch (e) {
    console.warn('[viewManager] IDB health probe failed on visibility change:', e);

    const { reportIDBFailure, attemptRecovery } = await import('../indexedDB/core/healthMonitor');
    // Report twice to immediately cross the failure threshold
    reportIDBFailure(e);
    reportIDBFailure(e);
    attemptRecovery();
  }
});

export async function cleanupReaderView() {
  verbose.init('Cleaning up previous reader view', 'viewManager.js');

  // Close any open containers before destroying the view
  await closeHyperlitContainer(true); // silent=true: URL will be replaced by the calling navigation's pushState

  // SPA TRANSITION FIX: Do not remove the navigation overlay here.
  // It is shown just before the transition and must persist.

  // Clean up global event handlers via LinkNavigationHandler
  removeGlobalHandlers();

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
    const { destroyEditToolbar } = await import('../editToolbar/index');
    destroyEditToolbar();
  } catch (e) {
    // Module not loaded yet, nothing to destroy
  }

  try {
    const { stopObserving } = await import('../divEditor/index');
    await stopObserving();
  } catch (e) {
    // Module not loaded yet, nothing to stop
  }

  destroySelectionHandler();

  // ✅ Clean up content-specific listeners (hyperlights, hypercites)
  try {
    const { cleanupHighlightingControls } = await import('../hyperlights/selectionToolbar');
    cleanupHighlightingControls();
  } catch (e) {
    // Module not loaded yet, nothing to cleanup
  }

  try {
    const { cleanupUnderlineClickListeners } = await import('../hypercites/index');
    cleanupUnderlineClickListeners();
  } catch (e) {
    // Module not loaded yet, nothing to cleanup
  }

  try {
    const { destroyHyperlitManager } = await import('../hyperlitContainer/index');
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

  const currentPageType = document.body.getAttribute('data-page');
  verbose.init(`Page type: ${currentPageType}`, 'viewManager.js');

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

  // Re-apply vibe CSS after SPA navigation so the canvas + theme persist.
  // (The base `theme-*` body class is preserved synchronously across the body
  // swap by syncBodyAttributes(), so only the vibe canvas needs re-applying.)
  import('../components/settingsContainer/themeSwitcher').then(({ getCurrentTheme, THEMES }) => {
    if (getCurrentTheme() === THEMES.VIBE) {
      import('../components/settingsContainer/vibeCSS/index').then(m => m.applyVibeCSS());
    }
  });

  // ✅ Check if this is an imported book
  const isImportedBook = sessionStorage.getItem('imported_book_initializing');

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
  const { waitForLayoutStabilization } = await import('./domReadiness');

  // Wait for both content loading and layout stabilization to complete
  await Promise.all([loadPromise, waitForLayoutStabilization()]);

  verbose.init('DOM settled. Initializing static UI components', 'viewManager.js');

  // ✅ REMOVED: Manual TogglePerimeterButtons management
  // OLD CODE (conflicted with ButtonRegistry):
  // import('../pageLoad/index').then(module => {
  //   module.togglePerimeterButtons.destroy();
  //   module.togglePerimeterButtons.rebindElements();
  //   module.togglePerimeterButtons.init();
  // });
  // NOW: ButtonRegistry handles this automatically via initializeAll()

  // Initialize components that work on both page types
  verbose.init('Universal components initialized', 'viewManager.js');
    await initializeUniversalComponents(currentPageType);

    // 🔧 CRITICAL: Attach global handlers (popstate/visibility, focus) for ALL page types
    // This must happen BEFORE early return for home/user pages
    attachGlobalLinkClickHandler();
    verbose.init('Navigation handlers attached', '/SPA/navigation/LinkNavigationHandler.js');

    // Initialize auth listeners for ALL page types
    initializeAuthBroadcastListener();  // Cross-tab sync
    initializeAuthStateListener();       // Same-tab UI updates

    // For homepage and user pages, skip reader-specific initialization
    // Content loading is handled by initializeHomepageButtons() for these page types
    if (currentPageType === 'home' || currentPageType === 'user') {
      return; // Exit early - everything is handled by homepage/user page system
    }

    // ✅ Initialize ALL registered components for reader page
    await buttonRegistry.initializeAll('reader');

    // Initialize reader-specific features not managed by ButtonRegistry. hyperlights/hypercites are
    // reader-only lazy chunks — loaded here (this block runs only on reader pages, after the home/user
    // early-return above) so home/user never fetch them. Downloads run in parallel with content load.
    updateEditButtonVisibility(currentBookId);
    const [{ initializeHighlightManager }, { initializeHighlightingControls }, { initializeHypercitingControls }] =
      await Promise.all([import('../hyperlights/index'), import('../hyperlights/selectionToolbar'), import('../hypercites/index')]);
    initializeHighlightManager();
    initializeHighlightingControls(currentBookId);
    initializeHypercitingControls(currentBookId);
    initializeSelectionHandler();
    
    // Initialize user profile page functionality if user owns this book
    const { getCurrentUser } = await import('../utilities/auth/index');
    const user = await getCurrentUser();
    verbose.init(`User profile check: user=${user?.name || 'null'}, currentBookId=${currentBookId}`, 'viewManager.js');
    if (user && user.name === currentBookId) {
      const { initializeUserProfilePage } = await import('../components/userProfile/userProfilePage');
      initializeUserProfilePage();
      verbose.init('User profile page functionality initialized', 'viewManager.js');
    }
    
    // Initialize SelectionDeletionHandler. The editor chunk (divEditor) is lazy — load it in the
    // background here (non-blocking) so it's warm before the user edits, without a static import that
    // would pin the chunk eager on every page.
    const editorContainer = document.querySelector('.main-content');
    if (editorContainer) {
      Promise.all([import('../divEditor/selectionDelete'), import('../divEditor/index')])
        .then(([{ SelectionDeletionHandler }, { queueNodeForDeletion, queueNodeForSave }]) => {
          activeSelectionDeletionHandler = new SelectionDeletionHandler(editorContainer, {
            queueNodeForDeletion,
            queueNodeForSave,
          });
          verbose.init('SelectionDeletionHandler initialized (lazy editor chunk)', 'viewManager.js');
        })
        .catch((e) => console.warn('Failed to init SelectionDeletionHandler:', e));
    } else {
      verbose.init(`No .main-content found for SelectionDeletionHandler (page type: ${currentPageType})`, 'viewManager.js');
    }
    
    // ✅ Dynamically import edit toolbar only when needed
    const { initEditToolbar } = await import('../editToolbar/index');
    initEditToolbar({
      toolbarId: "edit-toolbar",
      editableSelector: ".main-content[contenteditable='true']",
      currentBookId: currentBookId,
    });

  await loadPromise;
  verbose.init('Content loading process complete', 'viewManager.js');

  activeKeyboardManager = new KeyboardManager();
  window.activeKeyboardManager = activeKeyboardManager; // Make it globally accessible for citationMode
  window.addEventListener("beforeunload", () => {
    if (activeKeyboardManager) activeKeyboardManager.destroy();
  });
  restoreScrollPosition();
  import('../hyperlights/index').then(({ attachMarkListeners }) => attachMarkListeners());

  // ✅ Attach hypercite click listeners after content loads
  const { attachUnderlineClickListeners } = await import('../hypercites/index');
  attachUnderlineClickListeners();

  // Note: LinkNavigationHandler.attachGlobalLinkClickHandler() now called earlier for all page types
  initializeBroadcastListener();
  setupUnloadSync();

  // ✅ NOTE: Component initialization (toc, settings, etc.) now handled by
  // buttonRegistry.initializeAll('reader') above - no duplicate calls needed

  // ✅ CRITICAL: Check auth state and update edit button permissions after reader initialization
  await checkEditPermissionsAndUpdateUI();
  verbose.init('Auth state checked and edit permissions updated in reader view', 'viewManager.js');
  
  // 🔥 Rebind container managers AFTER content loads
  // Note: footnoteCitationListeners now handled by ButtonRegistry
  setTimeout(async () => {
    const { hyperlitManager, initializeHyperlitManager } = await import('../hyperlitContainer/index');
    if (hyperlitManager && hyperlitManager.rebindElements) {
        hyperlitManager.rebindElements();
        verbose.init('Hyperlit container manager rebound after content load', 'viewManager.js');
    } else {
        initializeHyperlitManager();
        verbose.init('Hyperlit container manager re-initialized after SPA transition', 'viewManager.js');
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
    const cleanState: any = {
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
async function initializeUniversalComponents(pageType: any) {
  try {
    verbose.init(`Initializing universal components for page type: ${pageType}`, 'viewManager.js');

    // ✅ Initialize all registered components for this page type (home/user)
    // Components registered for 'home' and 'user' page types will be initialized
    if (pageType === 'home' || pageType === 'user') {
      await buttonRegistry.initializeAll(pageType);
    }

    // SPA Transition Fix: If the transition pathway has already initialized
    // containers, skip doing it again here to prevent state corruption.
    if ((window as any).containersAlreadyInitialized) {
        verbose.init('[SPA] Skipping container/homepage initialization as it was handled by the transition', 'viewManager.js');
    } else {
        // ✅ NOTE: userContainer initialization now handled by ButtonRegistry above
        // Legacy manual initialization removed to prevent duplicates

        // Initialize homepage-specific components for both home AND user pages
        // User pages share the same structure as home pages (book grid, etc.)
        if (pageType === 'home' || pageType === 'user') {
          try {
            verbose.init(`Initializing homepage components for ${pageType} page`, 'viewManager.js');
            const { initializeHomepage } = await import('../components/homepage/homepage');
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
            const { initializeUserProfileEditor } = await import('../components/userProfile/userProfileEditor');
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


