

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

// Function to record when this page loaded
function recordPageLoadTimestamp() {
  pageLoadTimestamp = Date.now();
  console.log(`📋 Page load timestamp recorded: ${pageLoadTimestamp}`);
}

// Function to check if cache has been invalidated since this page loaded
function checkCacheInvalidation() {
  try {
    const invalidationTimestamp = localStorage.getItem('auth_cache_invalidation');
    
    if (!invalidationTimestamp) {
      console.log("✅ No cache invalidation timestamp found - cache is valid");
      return false;
    }
    
    const invalidationTime = parseInt(invalidationTimestamp);
    
    if (!pageLoadTimestamp) {
      console.log("⚠️ No page load timestamp - recording current time and assuming cache valid");
      recordPageLoadTimestamp();
      return false;
    }
    
    // If cache was invalidated AFTER this page loaded, we need to refresh
    const needsRefresh = invalidationTime > pageLoadTimestamp;
    
    if (needsRefresh) {
      console.log(`🔄 Cache invalidation detected:`);
      console.log(`  Page loaded at: ${pageLoadTimestamp}`);
      console.log(`  Cache invalidated at: ${invalidationTime}`);
      console.log(`  This page needs fresh data!`);
    } else {
      console.log(`✅ Cache is valid:`);
      console.log(`  Page loaded at: ${pageLoadTimestamp}`);
      console.log(`  Last invalidation: ${invalidationTime}`);
    }
    
    return needsRefresh;
  } catch (error) {
    console.error("❌ Error checking cache invalidation:", error);
    return false;
  }
}

// Function to refresh highlights with current auth context
async function refreshHighlightsWithCurrentAuth() {
  try {
    console.log("🎨 Refreshing highlights with current auth context");
    
    // Get all existing mark elements
    const existingMarks = document.querySelectorAll('mark[class*="HL_"]');
    console.log(`🎨 Found ${existingMarks.length} existing highlights to refresh`);
    
    if (existingMarks.length === 0) {
      console.log("🎨 No highlights found to refresh");
      return;
    }
    
    // Get current book ID
    const currentBook = book;
    if (!currentBook) {
      console.warn("🎨 No current book ID found");
      return;
    }
    
    // Import necessary modules
    const { getNodeChunksFromIndexedDB } = await import('./cache-indexedDB.js');
    const { applyHighlights } = await import('./lazyLoaderFactory.js');
    
    // Get fresh data from IndexedDB (which should have been updated with current auth context)
    const nodeChunks = await getNodeChunksFromIndexedDB(currentBook);
    if (!nodeChunks || nodeChunks.length === 0) {
      console.warn("🎨 No node chunks found in IndexedDB");
      return;
    }
    
    // For each existing mark, find its container and re-apply highlights
    const processedContainers = new Set();
    
    for (const mark of existingMarks) {
      // Find the container element (the one with a numerical ID)
      const container = mark.closest('[id]');
      if (!container || processedContainers.has(container.id)) {
        continue;
      }
      
      // Find the corresponding node chunk
      const nodeId = parseFloat(container.id);
      const nodeChunk = nodeChunks.find(chunk => chunk.startLine === nodeId);
      
      if (nodeChunk && nodeChunk.hyperlights && nodeChunk.hyperlights.length > 0) {
        console.log(`🎨 Refreshing highlights in container ${container.id}`);
        
        // Get the original content without highlights
        const originalContent = nodeChunk.content;
        
        // Re-apply highlights with current auth context
        const refreshedContent = applyHighlights(originalContent, nodeChunk.hyperlights, currentBook);
        
        // Update the container's content
        container.innerHTML = refreshedContent;
        
        processedContainers.add(container.id);
      }
    }
    
    // Re-attach mark listeners to the refreshed elements
    const { attachMarkListeners } = await import('./hyperLights.js');
    attachMarkListeners();
    
    console.log(`✅ Refreshed highlights in ${processedContainers.size} containers`);
    
  } catch (error) {
    console.error("❌ Error refreshing highlights:", error);
  }
}

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
          
          // Check if cache has been invalidated due to auth changes
          const needsRefresh = checkCacheInvalidation();
          
          if (needsRefresh) {
            console.log("🔄 Cache invalidation detected - forcing page reload for fresh auth context");
            window.location.reload();
            return;
          } else {
            console.log("✅ Cache valid - normal SPA navigation");
            // Just ensure interactive features are working
            await checkEditPermissionsAndUpdateUI();
          }
          
        } catch (error) {
          console.error("❌ Error handling browser navigation:", error);
        }
      }, 200);
    }
  }
});

function cleanupReaderView() {
  console.log("🧹 Cleaning up previous reader view...");

  // Close any open containers before destroying the view
  closeHyperlitContainer();

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

export async function transitionToReaderView(bookId, hash = '') {
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
    const newUrl = `/${bookId}/edit?target=1&edit=1${hash}`;
    history.pushState({}, "", newUrl);

    // Call the simple initializer.
    await initializeReaderView();
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
      // Skip if this is a hypercite or TOC link (they handle their own overlays)
      const isHypercite = link.closest('u.couple, u.poly');
      const isTocLink = link.closest('#toc-container');
      
      if (isHypercite || isTocLink) {
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
          showNavigationLoading(`hyperlight: ${highlightId}`);
          
          // Use the special hyperlight+hypercite navigation
          transitionToReaderView(targetBookId, '').then(() => {
            // After page loads, navigate to the hyperlight+hypercite
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
          });
        } else if (targetBookId) {
          console.log(`🎯 Global link: Starting SPA transition to book: ${targetBookId}${targetHash}`);
          showNavigationLoading(`book: ${targetBookId}`);
          transitionToReaderView(targetBookId, targetHash);
        } else {
          console.warn('Could not determine target book ID for SPA transition. Falling back to full page load.');
          window.location.href = link.href;
        }
      }
    }
  };
  
  // Clear overlay when page becomes visible again (handles back button cache issues)
  // But NOT if we just clicked a link and are about to navigate away
  let recentLinkClick = false;
  const recentLinkClickHandler = () => {
    recentLinkClick = true;
    setTimeout(() => { recentLinkClick = false; }, 1000);
  };
  
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
  document.addEventListener('click', recentLinkClickHandler);
  document.addEventListener('visibilitychange', globalVisibilityHandler);
  window.addEventListener('focus', globalFocusHandler);
  window.addEventListener('popstate', globalPopstateHandler);
}

export async function initializeReaderView() {
  const currentBookId = book;
  console.log(`🚀 Initializing Reader View for book: ${currentBookId}`);
  
  // Record when this page loaded for cache invalidation checking
  recordPageLoadTimestamp();
  
  // Check if cache has been invalidated and reload if needed
  const needsRefresh = checkCacheInvalidation();
  if (needsRefresh) {
    console.log("🔄 Cache invalidation detected during initialization - reloading for fresh data");
    window.location.reload();
    return;
  }
  
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
    // Use the persistent NavButtons instance from reader-DOMContentLoaded.js
    import('./reader-DOMContentLoaded.js').then(module => {
      if (module.navButtons) {
        module.navButtons.rebindElements();
        console.log("✅ Rebound persistent NavButtons instance");
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
  attachGlobalLinkClickHandler();
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
  
  // 🎯 IMMEDIATE CLEANUP: Remove overlays as soon as navigation is complete
  // Listen for the navigation completion and clean up immediately
  const cleanupOverlays = () => {
    const leftoverOverlays = document.querySelectorAll('.navigation-overlay');
    leftoverOverlays.forEach(overlay => {
      console.log("🎯 IMMEDIATE: Removing navigation overlay:", overlay);
      overlay.remove();
    });
    if (leftoverOverlays.length > 0) {
      console.log(`🎯 IMMEDIATE CLEANUP: Removed ${leftoverOverlays.length} overlays`);
    }
  };
  
  // Clean up overlays when content is ready
  setTimeout(cleanupOverlays, 100);
}


