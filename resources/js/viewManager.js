

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
  resolveFirstChunkPromise
} from "./initializePage.js";

// State management and cleanup are correct.
let activeNavButtons = null;
let activeKeyboardManager = null;

// Handle page restoration from browser cache (bfcache) - critical for mobile
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    console.log("🔄 Page restored from bfcache - reinitializing interactive features");
    const pageType = document.body.getAttribute("data-page");
    
    if (pageType === "reader") {
      // Small delay to ensure DOM is fully restored
      setTimeout(() => {
        try {
          console.log("🔧 Reinitializing interactive features after cache restore...");
          
          // Import and reinitialize footnote/citation listeners
          import('./footnotes-citations.js').then(module => {
            module.initializeFootnoteCitationListeners();
            console.log("✅ Footnote/citation listeners reinitialized");
            
            // Also rebind the reference container manager
            if (module.refManager && module.refManager.rebindElements) {
              module.refManager.rebindElements();
              console.log("✅ Reference container manager rebound");
            }
          });
          
          // Reinitialize TOC
          generateTableOfContents("toc-container", "toc-toggle-button");
          console.log("✅ TOC reinitialized");
          
          // Reinitialize hyperlight listeners
          attachMarkListeners();
          initializeHighlightingControls(book);
          console.log("✅ Hyperlight listeners reinitialized");
          
          // Reinitialize hyperciting
          initializeHypercitingControls(book);
          console.log("✅ Hyperciting controls reinitialized");
          
          // Reinitialize nav buttons if they exist
          const navButtonsContainer = document.querySelector('#nav-buttons');
          if (navButtonsContainer && !activeNavButtons) {
            activeNavButtons = new NavButtons({
              elementIds: ["nav-buttons", "logoContainer", "topRightContainer"],
              tapThreshold: 15,
            });
            activeNavButtons.init();
            console.log("✅ Nav buttons reinitialized");
          }
          
          console.log("🎉 All interactive features reinitialized after cache restore");
          
        } catch (error) {
          console.error("❌ Error reinitializing after cache restore:", error);
        }
      }, 150); // Slightly longer delay for mobile
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
        
        // Check if this is a same-page anchor link
        const linkUrl = new URL(link.href, window.location.origin);
        const currentUrl = new URL(window.location.href);
        const isSamePage = linkUrl.pathname === currentUrl.pathname && 
                          linkUrl.search === currentUrl.search && 
                          linkUrl.hash !== '';
        
        if (isSamePage) {
          // For same-page anchor links, no overlay needed - just internal navigation
          console.log(`✅ Same-page anchor link detected: ${linkUrl.hash} - no overlay needed`);
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


