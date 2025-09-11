

import { book, setCurrentBook } from "./app.js";

import { stopObserving, initTitleSync } from "./divEditor.js";
import { initEditToolbar, destroyEditToolbar } from "./editToolbar.js";
import NavButtons from "./nav-buttons.js";
import { restoreScrollPosition, restoreNavigationOverlayIfNeeded, showNavigationLoading, hideNavigationLoading } from "./scrolling.js";
import {
  attachMarkListeners,
  initializeHighlightingControls,
  initializeHighlightManager,
} from "./hyperLights.js";
import { initializeHypercitingControls } from "./hyperCites.js";
import { initializeBroadcastListener } from "./BroadcastListener.js";
import { setupUnloadSync } from "./cache-indexedDB.js";
import { generateTableOfContents } from "./toc.js";
import { KeyboardManager } from "./keyboardManager.js";
import {
  initializeEditButtonListeners,
  updateEditButtonVisibility,
  handleAutoEdit,
  enforceEditableState
} from "./editButton.js";
import { initializeSourceButtonListener } from "./sourceButton.js";
import {
  initializeSelectionHandler,
  destroySelectionHandler,
} from "./selectionHandler.js";
import {
  loadHyperText,
  pendingFirstChunkLoadedPromise,
  resolveFirstChunkPromise,
  resetCurrentLazyLoader
} from "./initializePage.js";

// State management and cleanup are correct.
let activeNavButtons = null;
let activeKeyboardManager = null;

// Handle page restoration from browser cache (bfcache) - critical for mobile and desktop
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    console.log("🔄 Page restored from bfcache - reinitializing interactive features");
    const pageType = document.body.getAttribute("data-page");
    
    // ✅ EXPANDED: Handle both reader pages AND homepage with reader content
    const hasReaderContent = pageType === "reader" || document.querySelector('.main-content, .book-content');
    
    if (hasReaderContent) {
      // Small delay to ensure DOM is fully restored
      setTimeout(async () => {
        try {
          console.log("🔧 Reinitializing ALL interactive features after cache restore...");
          const currentBookId = book;
          
          // ✅ CRITICAL: Use the same helper function from initializePage.js
          // Import the helper function and use it for consistent initialization
          try {
            const { initializeInteractiveFeatures } = await import('./initializePage.js');
            if (typeof initializeInteractiveFeatures === 'function') {
              await initializeInteractiveFeatures(currentBookId);
              console.log("✅ Used centralized interactive features initialization");
            } else {
              throw new Error("initializeInteractiveFeatures not available");
            }
          } catch (importError) {
            console.warn("⚠️ Could not import centralized initializer, using fallback:", importError);
            
            // Fallback to manual initialization
            const [
              footnotesModule,
              { generateTableOfContents },
              { attachMarkListeners, initializeHighlightingControls },
              { initializeHypercitingControls }
            ] = await Promise.all([
              import('./footnotes-citations.js'),
              import('./toc.js'),
              import('./hyperLights.js'),
              import('./hyperCites.js')
            ]);
            
            // Initialize all features
            footnotesModule.initializeFootnoteCitationListeners();
            if (footnotesModule.refManager && footnotesModule.refManager.rebindElements) {
              footnotesModule.refManager.rebindElements();
            }
            
            generateTableOfContents("toc-container", "toc-toggle-button");
            attachMarkListeners();
            initializeHighlightingControls(currentBookId);
            initializeHypercitingControls(currentBookId);
            
            console.log("✅ Fallback initialization completed");
          }
          
          // Reinitialize nav buttons if they exist and aren't already active
          const navButtonsContainer = document.querySelector('#nav-buttons');
          if (navButtonsContainer && !activeNavButtons) {
            activeNavButtons = new NavButtons({
              elementIds: ["nav-buttons", "logoContainer", "topRightContainer"],
              tapThreshold: 15,
            });
            activeNavButtons.init();
            console.log("✅ Nav buttons reinitialized");
          }
          
          console.log("🎉 All interactive features reinitialized after bfcache restore");
          
        } catch (error) {
          console.error("❌ Error reinitializing after cache restore:", error);
        }
      }, 200); // Slightly longer delay for mobile
    }
  }
});

// Additional handler for visibility change - covers cases where bfcache doesn't fire
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    const pageType = document.body.getAttribute("data-page");
    const hasReaderContent = pageType === "reader" || document.querySelector('.main-content, .book-content');
    
    if (hasReaderContent) {
      // Check if interactive features are working
      setTimeout(() => {
        const tocToggle = document.getElementById('toc-toggle-button');
        const highlightButtons = document.querySelectorAll('.highlight-control-button');
        
        if (tocToggle && !tocToggle.onclick && !tocToggle.getAttribute('data-initialized')) {
          console.log("🔍 Detected missing TOC functionality after visibility change - reinitializing");
          
          import('./initializePage.js').then(({ initializeInteractiveFeatures }) => {
            const currentBookId = book;
            initializeInteractiveFeatures(currentBookId).then(() => {
              console.log("✅ Interactive features reinitialized after visibility change");
            }).catch(error => {
              console.error("❌ Error reinitializing after visibility change:", error);
            });
          });
        }
      }, 300);
    }
  }
});

function cleanupReaderView() {
  console.log("🧹 Cleaning up previous reader view...");
  if (activeNavButtons) {
    activeNavButtons = null;
  }
  if (activeKeyboardManager) {
    activeKeyboardManager.destroy();
    activeKeyboardManager = null;
  }
  destroyEditToolbar();
  stopObserving();
  destroySelectionHandler();
}

export async function initializeImportedBook(bookId) {
  console.log(`🔥 DEBUG: initializeImportedBook CALLED for ${bookId}`);
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
    const { enableEditMode } = await import('./editButton.js');
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

  // ✅ Call the ACTUAL initializeReaderView function 
  await initializeReaderView();

  // ✅ NOW call handleAutoEdit since the page is fully initialized
  console.log("🎯 Checking for auto-edit after imported book initialization");
  import('./editButton.js').then(module => {
    module.handleAutoEdit();
  });
  
  console.log("✅ Imported book fully initialized via standard reader flow");
}

export async function transitionToReaderView(bookId) {
  try {
    cleanupReaderView();

    const response = await fetch(`/${bookId}/edit?target=1`);
    if (!response.ok) throw new Error("Failed to fetch reader page HTML");
    const htmlString = await response.text();

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, "text/html");

    // 🔥 SIMPLE FIX: Remove the overlay from the fetched HTML before injecting it
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
      console.log('🎯 TransitionToReader: Removed overlay from fetched HTML before injection');
    }

    document.body.innerHTML = newDoc.body.innerHTML;
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }
    document.title = newDoc.title;

    setCurrentBook(bookId);
    history.pushState({}, "", `/${bookId}/edit?target=1&edit=1`);

    // Call the simple initializer.
    await initializeReaderView();
  } catch (error) {
    console.error("SPA Transition Failed:", error);
    window.location.href = `/${bookId}/edit?target=1&edit=1`;
  }
}


// Global link click handler to show overlay for all links
function attachGlobalLinkClickHandler() {
  document.addEventListener('click', (event) => {
    // Find the closest anchor tag (in case user clicked on child element)
    const link = event.target.closest('a');
    
    if (link && link.href) {
      // Skip if this is a hypercite or TOC link (they handle their own overlays)
      const isHypercite = link.closest('u.couple, u.poly');
      const isTocLink = link.closest('#toc-container');
      
      if (!isHypercite && !isTocLink) {
        console.log(`🎯 Global link click detected: ${link.href}`);
        
        // Check if this is internal book navigation (same book, possibly different highlight/section)
        const linkUrl = new URL(link.href, window.location.origin);
        const currentUrl = new URL(window.location.href);
        
        // Check for same-page anchor links
        const isSamePage = linkUrl.pathname === currentUrl.pathname && 
                          linkUrl.search === currentUrl.search && 
                          linkUrl.hash !== '';
        
        // Check for same-book navigation (links that start with the same book path)
        const currentBookPath = `/${book}`;
        const isInternalBookNavigation = linkUrl.pathname.startsWith(currentBookPath) && 
                                        linkUrl.hash !== '';
        
        if (isSamePage || isInternalBookNavigation) {
          // For internal book navigation, no overlay needed - just internal navigation
          const navigationType = isSamePage ? "same-page" : "same-book";
          console.log(`✅ Internal ${navigationType} navigation detected: ${linkUrl.hash} - no overlay needed`);
          
          // Check if this is internal navigation - prevent default and use our navigation
          const targetId = linkUrl.hash.substring(1);
          const isInternalTarget = targetId.startsWith('hypercite_') || targetId.startsWith('HL_') || /^\d+$/.test(targetId);
          
          if (isInternalTarget) {
            event.preventDefault();
            console.log(`🎯 Preventing default for internal link, using custom navigation to: ${targetId}`);
            
            // For links with highlight in path (like /book_123/HL_456#hypercite_789)
            // extract the highlight ID from the path if present
            let primaryTarget = targetId; // The hash fragment (e.g., hypercite_789)
            const pathMatch = linkUrl.pathname.match(/\/(HL_\w+)(?:\/|$)/);
            
            if (pathMatch && pathMatch[1]) {
              // If there's a highlight in the path, just navigate to the highlight
              // The hypercite will be accessible within the highlight container
              console.log(`🎯 Detected highlight in path: ${pathMatch[1]}, hash target: ${targetId}`);
              console.log(`🎯 Navigating to highlight only - hypercite will be accessible in container`);
              primaryTarget = pathMatch[1]; // Navigate to the highlight only
            }
            
            // Import and call navigateToInternalId
            import('./scrolling.js').then(({ navigateToInternalId }) => {
              import('./initializePage.js').then(({ currentLazyLoader }) => {
                if (currentLazyLoader) {
                  // Update URL manually since we prevented default
                  window.history.pushState(null, '', `${linkUrl.pathname}${linkUrl.search}${linkUrl.hash}`);
                  
                  // Navigate to the primary target (highlight or direct hash)
                  navigateToInternalId(primaryTarget, currentLazyLoader, false);
                  
                  // For highlight navigation, don't do secondary hypercite navigation
                  // The hypercite will be accessible within the opened highlight container
                } else {
                  console.warn('currentLazyLoader not available for internal navigation');
                }
              });
            });
          }
        } else {
          // Show overlay for external/different page links
          const targetDisplay = link.textContent.trim() || link.href;
          showNavigationLoading(`link: ${targetDisplay}`);
        }
      }
    }
  });
  
  // Clear overlay when page becomes visible again (handles back button cache issues)
  // But NOT if we just clicked a link and are about to navigate away
  let recentLinkClick = false;
  document.addEventListener('click', () => {
    recentLinkClick = true;
    setTimeout(() => { recentLinkClick = false; }, 1000);
  });
  
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !recentLinkClick) {
      // Page is visible again, clear any stuck overlay
      // But only if we didn't just click a link (which would be navigating away)
      console.log('🎯 Visibility change - clearing overlay (not from recent link click)');
      hideNavigationLoading();
    }
  });
  
  // Also handle page focus as fallback
  window.addEventListener('focus', () => {
    hideNavigationLoading();
  });
  
  // Handle browser back/forward navigation
  window.addEventListener('popstate', (event) => {
    console.log(`🎯 Browser navigation detected (back/forward)`);
    
    // Check if there's a hash in the current URL
    const targetId = window.location.hash.substring(1);
    if (targetId) {
      // Check if this is internal navigation
      const isInternalNavigation = targetId.startsWith('hypercite_') || 
                                  targetId.startsWith('HL_') || 
                                  /^\d+$/.test(targetId);
      
      if (isInternalNavigation) {
        console.log(`✅ Browser navigation to internal target: ${targetId} - no overlay needed`);
        
        // If this is a hypercite, use our custom navigation with highlighting
        if (targetId.startsWith('hypercite_')) {
          console.log(`🎯 Browser navigation to hypercite, using custom navigation: ${targetId}`);
          
          // Import and call navigateToInternalId
          import('./scrolling.js').then(({ navigateToInternalId }) => {
            import('./initializePage.js').then(({ currentLazyLoader }) => {
              if (currentLazyLoader) {
                navigateToInternalId(targetId, currentLazyLoader, false);
              } else {
                console.warn('currentLazyLoader not available for hypercite browser navigation');
              }
            });
          });
        }
      } else {
        // Only show overlay for external hash navigation
        showNavigationLoading(targetId);
      }
    }
    // Don't show overlay for general back/forward navigation
    // The page will either load from cache (no need for overlay) or
    // load fresh (will get overlay from initial page load system)
  });
}

export async function initializeReaderView() {
  const currentBookId = book;
  console.log(`🚀 Initializing Reader View for book: ${currentBookId}`);
  
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

  const loadPromise = loadHyperText(currentBookId);

  setTimeout(() => {
    console.log("✅ DOM settled. Initializing static UI components...");
    activeNavButtons = new NavButtons({
      elementIds: ["nav-buttons", "logoContainer", "topRightContainer"],
      tapThreshold: 15,
    });
    activeNavButtons.init();
    initializeEditButtonListeners();
    initializeSourceButtonListener();
    updateEditButtonVisibility(currentBookId);
    initializeHighlightManager();
    initializeHighlightingControls(currentBookId);
    initializeHypercitingControls(currentBookId);
    initializeSelectionHandler();
    initEditToolbar({
      toolbarId: "edit-toolbar",
      editableSelector: ".main-content[contenteditable='true']",
      currentBookId: currentBookId,
    });
  }, 0);

  await loadPromise;
  console.log("✅ Content loading process complete.");

  await initTitleSync(currentBookId);
  activeKeyboardManager = new KeyboardManager();
  window.addEventListener("beforeunload", () => {
    if (activeKeyboardManager) activeKeyboardManager.destroy();
  });
  restoreScrollPosition();
  attachMarkListeners();
  attachGlobalLinkClickHandler();
  initializeBroadcastListener();
  setupUnloadSync();
  generateTableOfContents("toc-container", "toc-toggle-button");
  
  // 🔥 Initialize footnote and citation listeners AFTER content loads
  // This ensures the DOM elements exist before we attach listeners
  setTimeout(async () => {
    const { initializeFootnoteCitationListeners } = await import('./footnotes-citations.js');
    initializeFootnoteCitationListeners();
    console.log("✅ Footnote and citation listeners initialized after content load");
    
    // 🔥 CRITICAL: Rebind the reference container manager after SPA transitions
    // The ContainerManager needs fresh DOM references after HTML replacement
    const { refManager } = await import('./footnotes-citations.js');
    if (refManager && refManager.rebindElements) {
      refManager.rebindElements();
      console.log("✅ Reference container manager rebound after content load");
    }
  }, 1000);
}


