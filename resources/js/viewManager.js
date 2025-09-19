

import { book, setCurrentBook } from "./app.js";
import { getCurrentUser, getAnonymousToken } from "./auth.js";
import { checkEditPermissionsAndUpdateUI } from "./editButton.js";

import { stopObserving, initTitleSync } from "./divEditor.js";
import { initEditToolbar, destroyEditToolbar } from "./editToolbar.js";
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
import { SelectionDeletionHandler } from "./selectionDelete.js";
import {
  loadHyperText,
  pendingFirstChunkLoadedPromise,
  resolveFirstChunkPromise,
  resetCurrentLazyLoader
} from "./initializePage.js";
import { closeHyperlitContainer } from './unified-container.js';

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

export function cleanupReaderView() {
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

  // Clean up global event handlers
  if (globalLinkClickHandler) {
    document.removeEventListener('click', globalLinkClickHandler);
    globalLinkClickHandler = null;
  }
  if (globalVisibilityHandler) {
    document.removeEventListener('visibilitychange', globalVisibilityHandler);
    globalVisibilityHandler = null;
  }
  if (globalFocusHandler) {
    window.removeEventListener('focus', globalFocusHandler);
    globalFocusHandler = null;
  }
  if (globalPopstateHandler) {
    window.removeEventListener('popstate', globalPopstateHandler);
    globalPopstateHandler = null;
  }

  if (activeKeyboardManager) {
    activeKeyboardManager.destroy();
    activeKeyboardManager = null;
  }
  if (activeSelectionDeletionHandler) {
    activeSelectionDeletionHandler.destroy();
    activeSelectionDeletionHandler = null;
  }
  destroyEditToolbar();
  stopObserving();
  destroySelectionHandler();
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

  // ✅ Call the ACTUAL universalPageInitializer function 
  await universalPageInitializer();

  // ✅ NOW call handleAutoEdit since the page is fully initialized
  console.log("🎯 Checking for auto-edit after imported book initialization");
  import('./editButton.js').then(module => {
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


// Track the global link click handler for cleanup
let globalLinkClickHandler = null;
let globalVisibilityHandler = null;
let globalFocusHandler = null;
let globalPopstateHandler = null;

// Global link click handler to show overlay for all links
function attachGlobalLinkClickHandler() {
  // Remove existing handlers if they exist
  if (globalLinkClickHandler) {
    document.removeEventListener('click', globalLinkClickHandler);
  }
  if (globalVisibilityHandler) {
    document.removeEventListener('visibilitychange', globalVisibilityHandler);
  }
  if (globalFocusHandler) {
    window.removeEventListener('focus', globalFocusHandler);
  }
  if (globalPopstateHandler) {
    window.removeEventListener('popstate', globalPopstateHandler);
  }

  globalLinkClickHandler = (event) => {
    // Find the closest anchor tag (in case user clicked on child element)
    const link = event.target.closest('a');
    
    if (link && link.href) {
      const isHypercite = link.closest('u.couple, u.poly') || link.classList.contains('hypercite-target');
      const isTocLink = link.closest('#toc-container');
      
      if (isHypercite || isTocLink) {
        const linkUrl = new URL(link.href, window.location.origin);
        const currentBookPath = `/${book}`;

        // Check if it's a cross-book navigation
        if (linkUrl.origin === window.location.origin && !linkUrl.pathname.startsWith(currentBookPath)) {
            const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
            const targetBookId = pathSegments[0] || 'book';
            console.log(`[PROGRESS-FIX] Cross-book hypercite detected. Showing progress bar for ${targetBookId}.`);
            import('./reader-DOMContentLoaded.js').then(({ updatePageLoadProgress }) => {
                updatePageLoadProgress(5, `Loading ${targetBookId}...`);
            });
        }
        return; // Let other handlers manage these
      }

      const linkUrl = new URL(link.href, window.location.origin);
      const currentUrl = new URL(window.location.href);

      // Check if it's a true external link (different domain)
      if (linkUrl.origin !== currentUrl.origin) {
        // The container-manager should have already set target="_blank"
        // so we don't need to do anything here.
        console.log(`🎯 Global link: Allowing external navigation to ${linkUrl.href}`);
        return;
      }

      // At this point, it's a same-origin link.

      const currentBookPath = `/${book}`;
      const isSamePageAnchor = linkUrl.pathname === currentUrl.pathname && linkUrl.hash !== '';
      const isSameBookNavigation = linkUrl.pathname.startsWith(currentBookPath) && linkUrl.hash !== '';

      if (isSamePageAnchor || isSameBookNavigation) {
        // It's a same-book navigation (e.g., to an anchor).
        event.preventDefault();
        console.log(`🎯 Global link: Handling same-book navigation to ${link.href}`);
        
        // Check if this is a same-book hyperlight URL pattern: /book/HL_123#hypercite_abc
        const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
        const isHyperlightURL = pathSegments.length > 1 && pathSegments[1].startsWith('HL_');
        
        if (isHyperlightURL) {
          const highlightId = pathSegments[1]; // HL_123
          const hyperciteId = linkUrl.hash.substring(1); // hypercite_abc (remove #)
          
          console.log(`🎯 Same-book hyperlight navigation: ${highlightId} -> ${hyperciteId}`);
          
          import('./hyperCites.js').then(({ navigateToHyperciteTarget }) => {
            import('./initializePage.js').then(({ currentLazyLoader }) => {
              if (currentLazyLoader) {
                window.history.pushState(null, '', link.href);
                if (hyperciteId) {
                  navigateToHyperciteTarget(highlightId, hyperciteId, currentLazyLoader);
                } else {
                  // Just navigate to highlight if no hypercite
                  import('./scrolling.js').then(({ navigateToInternalId }) => {
                    navigateToInternalId(highlightId, currentLazyLoader, false);
                  });
                }
              }
            });
          });
        } else {
          // Regular same-book navigation
          const targetId = linkUrl.hash.substring(1);
          import('./scrolling.js').then(({ navigateToInternalId }) => {
            import('./initializePage.js').then(({ currentLazyLoader }) => {
              if (currentLazyLoader) {
                window.history.pushState(null, '', link.href);
                navigateToInternalId(targetId, currentLazyLoader, false);
              }
            });
          });
        }
      } else {
        // It's a different book on the same origin. Handle as an SPA transition.
        event.preventDefault();
        
        const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
        const targetBookId = pathSegments[0];
        const targetHash = linkUrl.hash;

        // Check if this is a hyperlight URL pattern: /book/HL_123#hypercite_abc
        const isHyperlightURL = pathSegments.length > 1 && pathSegments[1].startsWith('HL_');
        
        if (isHyperlightURL) {
          const highlightId = pathSegments[1]; // HL_123
          const hyperciteId = targetHash.substring(1); // hypercite_abc (remove #)
          
          console.log(`🎯 Global link: Hyperlight SPA transition to ${targetBookId}/${highlightId}${targetHash}`);
          
          // ✅ Use proper progress system instead of basic overlay
          import('./reader-DOMContentLoaded.js').then(({ updatePageLoadProgress }) => {
            updatePageLoadProgress(5, `Loading ${targetBookId}...`);
          }).catch(() => {
            // Fallback to basic overlay if progress system unavailable
            showNavigationLoading(`hyperlight: ${highlightId}`);
          });
          
          // Create progress callback for this hyperlight SPA navigation
          const hyperlightProgressCallback = (percent, message) => {
            import('./reader-DOMContentLoaded.js').then(({ updatePageLoadProgress }) => {
              updatePageLoadProgress(percent, message || `Loading ${targetBookId} for ${highlightId}...`);
            }).catch(() => {
              console.warn('Progress system unavailable for hyperlight SPA navigation');
            });
          };

          // Use the special hyperlight+hypercite navigation with proper timing
          transitionToReaderView(targetBookId, '', hyperlightProgressCallback).then(async () => {
            // ✅ Wait for content to be fully loaded before internal navigation
            import('./initializePage.js').then(async ({ pendingFirstChunkLoadedPromise }) => {
              console.log(`🎯 SPA: Waiting for content to load before navigating to ${highlightId}${targetHash}`);
              
              try {
                // Wait for the content to be ready
                await pendingFirstChunkLoadedPromise;
                console.log(`✅ SPA: Content loaded, now navigating to ${highlightId}${targetHash}`);
                
                // Hide progress system now that content is ready
                import('./reader-DOMContentLoaded.js').then(({ hidePageLoadProgress }) => {
                  hidePageLoadProgress();
                }).catch(() => {
                  // Fallback to basic overlay if progress system unavailable
                  hideNavigationLoading();
                });
                
                // Now safely navigate to the target
                import('./hyperCites.js').then(({ navigateToHyperciteTarget }) => {
                  import('./initializePage.js').then(({ currentLazyLoader }) => {
                    if (currentLazyLoader && hyperciteId) {
                      console.log(`🎯 SPA: Sequential navigation to ${highlightId} then ${hyperciteId}`);
                      navigateToHyperciteTarget(highlightId, hyperciteId, currentLazyLoader, false);
                    } else if (currentLazyLoader) {
                      // Just navigate to highlight if no hypercite
                      import('./scrolling.js').then(({ navigateToInternalId }) => {
                        navigateToInternalId(highlightId, currentLazyLoader, false);
                      });
                    }
                  });
                });
              } catch (error) {
                console.error(`❌ SPA: Content loading failed for ${targetBookId}:`, error);
                import('./reader-DOMContentLoaded.js').then(({ hidePageLoadProgress }) => {
                  hidePageLoadProgress();
                }).catch(() => {
                  hideNavigationLoading();
                });
              }
            });
          });
        } else if (targetBookId) {
          console.log(`🎯 Global link: Starting SPA transition to book: ${targetBookId}${targetHash}`);
          
          // ✅ Use proper progress system instead of basic overlay
          import('./reader-DOMContentLoaded.js').then(({ updatePageLoadProgress }) => {
            updatePageLoadProgress(5, `Loading ${targetBookId}...`);
          }).catch(() => {
            // Fallback to basic overlay if progress system unavailable
            showNavigationLoading(`book: ${targetBookId}`);
          });
          
          // Create progress callback for this SPA navigation
          let progressRef = null;
          const spaProgressCallback = (percent, message) => {
            import('./reader-DOMContentLoaded.js').then(({ updatePageLoadProgress }) => {
              updatePageLoadProgress(percent, message || `Loading ${targetBookId}...`);
            }).catch(() => {
              console.warn('Progress system unavailable for SPA navigation');
            });
          };

          transitionToReaderView(targetBookId, targetHash, spaProgressCallback).then(async () => {
            // ✅ Wait for content to be fully loaded before completing navigation
            import('./initializePage.js').then(async ({ pendingFirstChunkLoadedPromise }) => {
              console.log(`🎯 SPA: Waiting for ${targetBookId} content to load`);
              
              try {
                // Wait for the content to be ready
                await pendingFirstChunkLoadedPromise;
                console.log(`✅ SPA: ${targetBookId} content loaded successfully`);
                
                // Hide progress system now that content is ready
                import('./reader-DOMContentLoaded.js').then(({ hidePageLoadProgress }) => {
                  hidePageLoadProgress();
                }).catch(() => {
                  // Fallback to basic overlay if progress system unavailable
                  hideNavigationLoading();
                });
                
                // If there's a hash to navigate to, do it now
                if (targetHash) {
                  const targetId = targetHash.substring(1);
                  import('./scrolling.js').then(({ navigateToInternalId }) => {
                    import('./initializePage.js').then(({ currentLazyLoader }) => {
                      if (currentLazyLoader) {
                        console.log(`🎯 SPA: Navigating to ${targetId} after content load`);
                        navigateToInternalId(targetId, currentLazyLoader, false);
                      }
                    });
                  });
                }
              } catch (error) {
                console.error(`❌ SPA: Content loading failed for ${targetBookId}:`, error);
                import('./reader-DOMContentLoaded.js').then(({ hidePageLoadProgress }) => {
                  hidePageLoadProgress();
                }).catch(() => {
                  hideNavigationLoading();
                });
              }
            });
          });
        } else {
          console.warn('Could not determine target book ID for SPA transition. Falling back to full page load.');
          window.location.href = link.href;
        }
      }
    }
  };
  
  // Clear overlay when page becomes visible again (handles back button cache issues)
  let recentLinkClick = false;
  
  globalVisibilityHandler = () => {
    if (!document.hidden && !recentLinkClick) {
      // Page is visible again, clear any stuck overlay
      // But only if we didn't just click a link (which would be navigating away)
      console.log('🎯 Visibility change - clearing overlay (not from recent link click)');
      hideNavigationLoading();
    }
  };
  
  // Also handle page focus as fallback
  globalFocusHandler = () => {
    hideNavigationLoading();
  };
  
  // Handle browser back/forward navigation
  globalPopstateHandler = (event) => {
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
  };

  // Add all the event listeners
  document.addEventListener('click', globalLinkClickHandler);
  document.addEventListener('click', () => {
    recentLinkClick = true;
    setTimeout(() => { recentLinkClick = false; }, 1000);
  });
  document.addEventListener('visibilitychange', globalVisibilityHandler);
  window.addEventListener('focus', globalFocusHandler);
  window.addEventListener('popstate', globalPopstateHandler);
}

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

  const loadPromise = loadHyperText(currentBookId, progressCallback);

  setTimeout(() => {
    console.log("✅ DOM settled. Initializing static UI components...");
    // Use the persistent NavButtons instance from reader-DOMContentLoaded.js
    import('./reader-DOMContentLoaded.js').then(module => {
      if (module.navButtons) {
        console.log("🔍 NavButtons before destroy - isInitialized:", module.navButtons.isInitialized);
        // Always destroy and reinitialize to ensure clean state after DOM changes
        module.navButtons.destroy();
        console.log("🔍 NavButtons after destroy - isInitialized:", module.navButtons.isInitialized);
        module.navButtons.rebindElements();
        console.log("🔍 NavButtons calling init() - isInitialized:", module.navButtons.isInitialized);
        module.navButtons.init();
        console.log("🔍 NavButtons after init() - isInitialized:", module.navButtons.isInitialized);
        module.navButtons.updatePosition();
        console.log("✅ Reinitialized NavButtons instance for universalPageInitializer");
      }
    });
    initializeEditButtonListeners();
    initializeSourceButtonListener();
    updateEditButtonVisibility(currentBookId);
    initializeHighlightManager();
    initializeHighlightingControls(currentBookId);
    initializeHypercitingControls(currentBookId);
    initializeSelectionHandler();
    
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
      console.warn("❌ Could not find .main-content for SelectionDeletionHandler");
    }
    
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
  // Use the new LinkNavigationHandler instead of inline logic
  const { LinkNavigationHandler } = await import('./navigation/LinkNavigationHandler.js');
  LinkNavigationHandler.attachGlobalLinkClickHandler();
  initializeBroadcastListener();
  setupUnloadSync();
  generateTableOfContents("toc-container", "toc-toggle-button");
  
  // ✅ CRITICAL: Check auth state and update edit button permissions after reader initialization
  await checkEditPermissionsAndUpdateUI();
  console.log("✅ Auth state checked and edit permissions updated in reader view");
  
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

    const { hyperlitManager } = await import('./unified-container.js');
    if (hyperlitManager && hyperlitManager.rebindElements) {
        hyperlitManager.rebindElements();
        console.log("✅ Hyperlit container manager rebound after content load");
    }
    
  }, 500);
  
}


