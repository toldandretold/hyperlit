/**
 * Hyperlit Container Core
 * Container lifecycle management (initialize, open, close)
 */

import { ContainerManager } from '../containerManager.js';
import { log, verbose } from '../utilities/logger.js';
import { ProgressOverlayConductor } from '../navigation/ProgressOverlayConductor.js';
// Note: cleanupContainerListeners and cleanupFootnoteListeners are imported dynamically
// to avoid circular dependency (index.js imports from core.js)

// Create the hyperlit container manager instance
export let hyperlitManager = null;

// ============================================================================
// EDIT MODE STATE MANAGEMENT
// ============================================================================
// Persists across container open/close cycles (stored in module memory)
// When user toggles edit mode, state is remembered for next container open

let isHyperlitEditMode = false;

/**
 * Get current edit mode state
 * @returns {boolean} Whether edit mode is enabled
 */
export function getHyperlitEditMode() {
  return isHyperlitEditMode;
}

/**
 * Set edit mode state
 * @param {boolean} enabled - Whether to enable edit mode
 */
export function setHyperlitEditMode(enabled) {
  isHyperlitEditMode = enabled;
  console.log(`✏️ Hyperlit edit mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

/**
 * Toggle edit mode state
 * @returns {boolean} The new edit mode state
 */
export function toggleHyperlitEditMode() {
  isHyperlitEditMode = !isHyperlitEditMode;
  console.log(`✏️ Hyperlit edit mode toggled to: ${isHyperlitEditMode ? 'ENABLED' : 'DISABLED'}`);
  return isHyperlitEditMode;
}

/**
 * Initialize the hyperlit container manager
 * Ensures DOM is ready before initialization
 */
export function initializeHyperlitManager() {
  // Ensure DOM is ready before initializing
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeHyperlitManagerInternal);
    return;
  }
  initializeHyperlitManagerInternal();
}

/**
 * Internal initialization function
 * @private
 */
function initializeHyperlitManagerInternal() {
  // Check if container exists in the DOM (should be there from blade template)
  const container = document.getElementById("hyperlit-container");
  if (!container) {
    console.error("❌ hyperlit-container not found in DOM! Check reader.blade.php");
    return;
  }

  // Check if overlay exists (should be there from blade template)
  const overlay = document.getElementById("ref-overlay");
  if (!overlay) {
    console.error("❌ ref-overlay not found in DOM! Check reader.blade.php");
    return;
  }

  // Now create the manager with the existing container and overlay
  hyperlitManager = new ContainerManager(
    "hyperlit-container",
    "ref-overlay",
    null,
    ["main-content", "nav-buttons"]
  );

  log.init('Hyperlit Container Manager initialized', '/hyperlitContainer/core.js');
}

/**
 * Open the hyperlit container with content
 * @param {string} content - HTML content to display
 * @param {boolean} isBackNavigation - Whether this is a back navigation
 */
export function openHyperlitContainer(content, isBackNavigation = false) {
  if (!hyperlitManager) {
    initializeHyperlitManager();
  }

  // Get the container (should exist after initialization)
  const container = document.getElementById("hyperlit-container");
  if (!container) {
    console.error("❌ hyperlit-container not found after initialization!");
    return;
  }

  // 🔒 SAVE scroll position FIRST, before any DOM changes
  const scrollContainer = document.querySelector('.reader-content-wrapper')
    || document.querySelector('.main-content')
    || document.querySelector('main');
  const savedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

  // Lock body scroll BEFORE opening container to prevent scroll during animation
  document.body.classList.add('hyperlit-container-open');
  console.log('🔒 Body scroll locked BEFORE container opens');

  // Set initial max-height
  // KeyboardManager will dynamically adjust this when keyboard opens/closes
  const viewportHeight = window.innerHeight;
  const topMargin = 16; // 1em top spacing (matches CSS top: 1em)
  const BOTTOM_GAP = 4; // Visual gap
  const maxHeight = viewportHeight - topMargin - BOTTOM_GAP;

  console.log(`📐 Setting initial container max-height: ${maxHeight}px (viewport: ${viewportHeight}px)`);
  console.log(`📐 KeyboardManager will handle dynamic height adjustments when keyboard opens/closes`);

  // Apply max-height as inline style
  container.style.maxHeight = `${maxHeight}px`;

  // Clear any existing content first to prevent duplicates
  const existingScroller = container.querySelector('.scroller');
  if (existingScroller) {
    existingScroller.innerHTML = '';
  }

  // Open the container using the manager
  console.log("📂 Opening container with manager...");

  // Set the back navigation flag on the manager
  hyperlitManager.isBackNavigation = isBackNavigation;

  hyperlitManager.openContainer();

  // Restore scroll position in case it shifted during container opening
  if (scrollContainer) {
    scrollContainer.scrollTop = savedScrollTop;
  }

  // Set content immediately (no setTimeout to preserve user gesture chain for Safari input)
  const scroller = container.querySelector('.scroller');
  if (scroller) {
    console.log(`📝 Setting content in scroller AFTER opening (${content.length} chars)`);

    // Clear content again just before setting to ensure no duplicates
    scroller.innerHTML = '';
    scroller.innerHTML = content;

    // Force layout flush before focus - Safari needs this to finalize contenteditable setup
    void scroller.offsetHeight;

    console.log(`✅ Content set after opening. Scroller innerHTML length: ${scroller.innerHTML.length}`);

    // Attach scroll containment handlers
    attachScrollContainment(scroller);
  } else {
    console.warn("⚠️ No scroller found in hyperlit-container after opening, setting content directly");
    // Clear and set content directly
    container.innerHTML = '';
    container.innerHTML = content;
  }

  // Final scroll restoration - ensure main content didn't scroll during any of the above
  if (scrollContainer) {
    scrollContainer.scrollTop = savedScrollTop;
  }
}

/**
 * Prepare container for closing - saves data if in edit mode with pending changes
 * Similar to disableEditMode() behavior
 */
async function prepareContainerClose() {
  // Check if we're in edit mode
  if (!window.isEditing) {
    console.log('[HyperlitContainer] Reader mode - no save needed');
    return; // Nothing to save in reader mode
  }
  
  console.log('[HyperlitContainer] Edit mode - preparing to close...');
  
  // Import divEditor functions
  const { flushInputDebounce, flushAllPendingSaves } = await import('../divEditor/index.js');
  
  // 🔑 CRITICAL: First flush input debounce to capture any pending typing
  // This forces the 200ms debounced input handler to execute immediately
  flushInputDebounce();
  
  // 🔑 CRITICAL: Then flush saveQueue BEFORE calling stopObserving()
  // stopObserving() sets saveQueue = null, so we must flush first!
  console.log('[HyperlitContainer] Flushing save queue...');
  await flushAllPendingSaves();
  
  console.log('[HyperlitContainer] Save complete');

  // Save preview_nodes locally for each active sub-book
  // This provides fast initial render on reopen without needing server data
  try {
    const { subBookLoaders } = await import('./subBookLoader.js');
    const { getNodeChunksFromIndexedDB, openDatabase } = await import('../indexedDB/index.js');

    for (const [subBookId] of subBookLoaders) {
      const nodes = await getNodeChunksFromIndexedDB(subBookId);
      if (!nodes?.length) continue;

      const previewNodes = nodes.slice(0, 5).map(n => ({
        book: n.book, chunk_id: n.chunk_id, startLine: n.startLine,
        node_id: n.node_id, content: n.content,
        footnotes: n.footnotes || [], hyperlights: n.hyperlights || [],
        hypercites: n.hypercites || [],
      }));

      const [parentBook, itemId] = subBookId.split('/');
      const db = await openDatabase();

      if (itemId.startsWith('Fn')) {
        const tx = db.transaction('footnotes', 'readwrite');
        const store = tx.objectStore('footnotes');
        const existing = await new Promise(r => {
          const req = store.get([parentBook, itemId]);
          req.onsuccess = () => r(req.result);
          req.onerror = () => r(null);
        });
        if (existing) {
          existing.preview_nodes = previewNodes;
          store.put(existing);
          await new Promise(r => { tx.oncomplete = r; });
        }
      } else if (itemId.startsWith('HL_')) {
        const tx = db.transaction('hyperlights', 'readwrite');
        const store = tx.objectStore('hyperlights');
        const idx = store.index('hyperlight_id');
        const existing = await new Promise(r => {
          const req = idx.get(itemId);
          req.onsuccess = () => r(req.result);
          req.onerror = () => r(null);
        });
        if (existing) {
          existing.preview_nodes = previewNodes;
          store.put(existing);
          await new Promise(r => { tx.oncomplete = r; });
        }
      }
      console.log(`💾 Saved preview_nodes for ${subBookId} (${previewNodes.length} nodes)`);
    }
  } catch (err) {
    console.warn('⚠️ Failed to save sub-book preview_nodes:', err);
  }
}

/**
 * Close the hyperlit container
 * @param {boolean} silent - If true, skip URL update (browser has already restored the URL via popstate)
 */
export async function closeHyperlitContainer(silent = false) {
  // Check if container exists in DOM before trying to do anything
  // On homepage, there's no hyperlit-container element
  const container = document.getElementById("hyperlit-container");
  if (!container) {
    return; // Nothing to close - container doesn't exist on this page
  }

  if (!hyperlitManager) {
    try {
      initializeHyperlitManager();
    } catch (error) {
      console.warn('Could not initialize hyperlitManager for closing:', error);
      return; // Exit early if initialization fails
    }
  }

  if (hyperlitManager && hyperlitManager.closeContainer) {
    try {
      // 🔑 CRITICAL: Prepare for close - save if in edit mode
      await prepareContainerClose();
      
      // 🔑 CRITICAL: Sequence cleanup
      // STEP 1: Flush any remaining saves
      console.log('[HyperlitContainer] 💾 Final cleanup...');
      const { cleanupContainerListeners } = await import('./index.js');
      await cleanupContainerListeners();
      console.log('[HyperlitContainer] ✅ Cleanup complete');
      
      // STEP 2: Now safe to destroy sub-books (after saves complete)
      const { destroyAllSubBooks } = await import('./subBookLoader.js');
      await destroyAllSubBooks(); // DOM elements destroyed here
      console.log('[HyperlitContainer] ✅ Sub-books destroyed');
      
      // STEP 3: Other cleanup (order less critical)
      const { detachNoteListeners } = await import('./noteListener.js');
      await detachNoteListeners();
      
      const { cleanupFootnoteListeners } = await import('../footnotes/footnoteAnnotations.js');
      await cleanupFootnoteListeners();

      // Remove scroll containment handlers (container already validated at function start)
      if (container) {
        const scroller = container.querySelector('.scroller');
        if (scroller) {
          removeScrollContainment(scroller);
        }
        // Reset inline max-height style
        container.style.maxHeight = '';
      }

      // Unlock body scroll
      // KeyboardManager handles all keyboard/viewport adjustments
      document.body.classList.remove('hyperlit-container-open');
      console.log('🔓 Body scroll unlocked');

      // Clean up URL hash and history state when closing container
      // If silent=true, the browser has already restored the URL via popstate — skip URL update
      if (!silent) {
        const currentUrl = window.location;
        const pathSegments = currentUrl.pathname.split('/').filter(Boolean);
        const isFootnotePath = pathSegments.length >= 2 && (pathSegments[1]?.includes('_Fn') || pathSegments[1]?.startsWith('Fn'));

        if (isFootnotePath) {
          // Remove footnote ID from path: /book/footnoteID -> /book
          const bookSlug = pathSegments[0] || '';
          const cleanUrl = `/${bookSlug}${currentUrl.search}`;
          console.log('🔗 Cleaning up footnote path from URL:', currentUrl.pathname, '→', cleanUrl);

          const currentState = history.state || {};
          const newState = {
            ...currentState,
            hyperlitContainer: null
          };
          history.replaceState(newState, '', cleanUrl);
        } else if (currentUrl.hash && (currentUrl.hash.startsWith('#HL_') || currentUrl.hash.startsWith('#hypercite_') ||
                               currentUrl.hash.startsWith('#footnote_') || currentUrl.hash.startsWith('#citation_'))) {
          // Remove hyperlit-related hash from URL
          const cleanUrl = `${currentUrl.pathname}${currentUrl.search}`;
          console.log('🔗 Cleaning up hyperlit hash from URL:', currentUrl.hash, '→', cleanUrl);

          const currentState = history.state || {};
          const newState = {
            ...currentState,
            hyperlitContainer: null
          };
          history.replaceState(newState, '', cleanUrl);
        }
      }

      hyperlitManager.closeContainer();
      console.log('[HyperlitContainer] ✅ Container closed successfully');
    } catch (error) {
      console.warn('Could not close hyperlit container:', error);
    }
  }
}

/**
 * Save and close the hyperlit container with progress overlay
 * Shows "Saving..." overlay while waiting for IndexedDB save to complete
 * Prevents data loss when closing container during active edit mode
 */
export async function saveAndCloseHyperlitContainer() {
  console.log('[HyperlitContainer] saveAndCloseHyperlitContainer() called');
  
  // Check if we're in edit mode with pending changes
  if (!window.isEditing) {
    console.log('[HyperlitContainer] Reader mode - closing without save');
    await closeHyperlitContainer();
    return;
  }
  
  console.log('[HyperlitContainer] Edit mode - showing save overlay and waiting for save...');
  
  // Show "Saving..." progress overlay with interaction blocking
  // This prevents the user from clicking again while save is in progress
  ProgressOverlayConductor.showSPATransition(
    50, 
    'Saving your changes...', 
    true // blockInteractions = true
  );
  
  try {
    // Prepare for close - this flushes input debounce and saves to IndexedDB
    await prepareContainerClose();
    
    // Update progress to 100%
    ProgressOverlayConductor.updateProgress(100, 'Save complete');
    
    // Small delay to show "Save complete" message before hiding
    await new Promise(resolve => setTimeout(resolve, 150));
    
    console.log('[HyperlitContainer] Save complete, hiding overlay and closing container');
    
    // Hide the progress overlay
    await ProgressOverlayConductor.hide();
    
    // Now safe to close the container
    await closeHyperlitContainer();
    
  } catch (error) {
    console.error('[HyperlitContainer] Error during save and close:', error);
    
    // Hide overlay even if there was an error
    await ProgressOverlayConductor.hide();
    
    // Still try to close the container
    await closeHyperlitContainer();
  }
}

/**
 * Destroy the hyperlit container manager
 * @returns {boolean} True if destroyed successfully
 */
export function destroyHyperlitManager() {
  if (hyperlitManager) {
    console.log('🧹 Destroying hyperlit container manager');
    hyperlitManager.destroy();
    hyperlitManager = null;
    return true;
  }
  return false;
}

/**
 * Prevent scroll propagation from container to page
 * @param {HTMLElement} scroller - The scroller element
 * @private
 */
function attachScrollContainment(scroller) {
  // Remove existing listeners if present
  if (scroller._scrollHandler) {
    scroller.removeEventListener('wheel', scroller._scrollHandler);
    scroller.removeEventListener('touchmove', scroller._touchHandler);
  }

  // Wheel event handler (mouse/trackpad scrolling)
  scroller._scrollHandler = function(e) {
    const scrollTop = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;
    const delta = e.deltaY;

    // At top and trying to scroll up
    if (delta < 0 && scrollTop <= 0) {
      e.preventDefault();
      return;
    }

    // At bottom and trying to scroll down
    if (delta > 0 && scrollTop + clientHeight >= scrollHeight) {
      e.preventDefault();
      return;
    }

    // Otherwise, let the scroll happen within the container
    e.stopPropagation();
  };

  // Touch event handler (mobile scrolling)
  let touchStartY = 0;
  scroller._touchHandler = function(e) {
    if (e.type === 'touchstart') {
      touchStartY = e.touches[0].clientY;
      return;
    }

    const scrollTop = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;
    const touchY = e.touches[0].clientY;
    const delta = touchStartY - touchY;

    // At top and trying to scroll up
    if (delta < 0 && scrollTop <= 0) {
      e.preventDefault();
      return;
    }

    // At bottom and trying to scroll down
    if (delta > 0 && scrollTop + clientHeight >= scrollHeight) {
      e.preventDefault();
      return;
    }

    // Otherwise, let the scroll happen within the container
    e.stopPropagation();
  };

  scroller.addEventListener('wheel', scroller._scrollHandler, { passive: false });
  scroller.addEventListener('touchstart', scroller._touchHandler, { passive: true });
  scroller.addEventListener('touchmove', scroller._touchHandler, { passive: false });

  console.log('✅ Scroll containment handlers attached');
}

/**
 * Remove scroll containment handlers
 * @param {HTMLElement} scroller - The scroller element
 * @private
 */
function removeScrollContainment(scroller) {
  if (scroller && scroller._scrollHandler) {
    scroller.removeEventListener('wheel', scroller._scrollHandler);
    scroller.removeEventListener('touchstart', scroller._touchHandler);
    scroller.removeEventListener('touchmove', scroller._touchHandler);
    delete scroller._scrollHandler;
    delete scroller._touchHandler;
    console.log('✅ Scroll containment handlers removed');
  }
}
