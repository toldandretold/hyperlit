/**
 * Hyperlit Container Core
 * Container lifecycle management (initialize, open, close)
 */

import { ContainerManager } from '../containerManager.js';
import { log, verbose } from '../utilities/logger.js';
import { ProgressOverlayConductor } from '../navigation/ProgressOverlayConductor.js';
import { clearCascadeOriginId } from '../scrolling.js';
// Note: cleanupContainerListeners and cleanupFootnoteListeners are imported dynamically
// to avoid circular dependency (index.js imports from core.js)

// Create the hyperlit container manager instance
export let hyperlitManager = null;

// Re-entrancy guard for saveAndCloseHyperlitContainer (prevents double-tap)
let isClosing = false;

// Re-entrancy guard for closeHyperlitContainer (prevents concurrent close calls)
let isClosingContainer = false;

/**
 * Check if closeHyperlitContainer is currently unwinding the stack.
 * Used by stack.js to skip URL trimming during bulk close.
 * @returns {boolean}
 */
export function isContainerClosing() {
  return isClosingContainer;
}

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
  // Destroy any existing manager to prevent handler accumulation on shared overlay
  if (hyperlitManager) {
    hyperlitManager.destroy();
    hyperlitManager = null;
  }

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
 * Prepare the hyperlit container with content but keep it off-screen.
 * The container is laid out (so content has real height) but not yet visible.
 * Call animateHyperlitContainerOpen() after async content loads to trigger the slide-in.
 *
 * Used for footnotes to avoid the "open empty then expand" jank — content loads
 * while the container is off-screen, then it slides in at full height.
 *
 * @param {string} content - HTML content to display
 * @param {boolean} isBackNavigation - Whether this is a back navigation
 */
export function prepareHyperlitContainer(content, isBackNavigation = false) {
  if (!hyperlitManager) {
    initializeHyperlitManager();
  }

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
  console.log('🔒 Body scroll locked (prepare phase)');

  // Set initial max-height
  const viewportHeight = window.innerHeight;
  const topMargin = 16;
  const BOTTOM_GAP = 4;
  const maxHeight = viewportHeight - topMargin - BOTTOM_GAP;

  console.log(`📐 Setting initial container max-height: ${maxHeight}px (viewport: ${viewportHeight}px)`);
  container.style.maxHeight = `${maxHeight}px`;

  // Reset container to initial structure (ensures .scroller, masks, controls exist)
  container.innerHTML = hyperlitManager.initialContent;

  // Make container participate in layout but keep off-screen.
  container.classList.remove('hidden');
  container.style.visibility = '';
  container.style.transform = '';

  hyperlitManager.isBackNavigation = isBackNavigation;

  // Set content inside the scroller (guaranteed to exist after initialContent reset)
  const scroller = container.querySelector('.scroller');
  if (scroller) {
    console.log(`📝 Setting content in scroller (off-screen prepare) (${content.length} chars)`);
    scroller.innerHTML = content;
    void scroller.offsetHeight; // Force layout flush
    console.log(`✅ Content set off-screen. Scroller innerHTML length: ${scroller.innerHTML.length}`);
    attachScrollContainment(scroller);
  }

  // Restore scroll position in case it shifted during setup
  if (scrollContainer) {
    scrollContainer.scrollTop = savedScrollTop;
  }
}

/**
 * Trigger the slide-in animation for a container that was set up with prepareHyperlitContainer().
 * This adds the .open class, which starts the CSS transform transition.
 */
export function animateHyperlitContainerOpen() {
  if (!hyperlitManager) return;

  const scrollContainer = document.querySelector('.reader-content-wrapper')
    || document.querySelector('.main-content')
    || document.querySelector('main');
  const savedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

  console.log("📂 Animating container open (deferred)...");
  hyperlitManager.openContainer(null, null, { skipContentReset: true });

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

  // Save preview_nodes for all active sub-books
  await savePreviewNodes();
}

/**
 * Save preview_nodes locally for each active sub-book.
 * Provides fast initial render on reopen without needing server data.
 * Extracted so both prepareContainerClose() and saveAndPopTopLayer() can reuse it.
 */
export async function savePreviewNodes() {
  try {
    const { subBookLoaders } = await import('./subBookLoader.js');
    const { getNodeChunksFromIndexedDB, openDatabase } = await import('../indexedDB/index.js');

    const { parseSubBookId } = await import('../utilities/subBookIdHelper.js');

    for (const [subBookId] of subBookLoaders) {
      const nodes = await getNodeChunksFromIndexedDB(subBookId);
      if (!nodes?.length) continue;

      const previewNodes = nodes.slice(0, 5).map(n => ({
        book: n.book, chunk_id: n.chunk_id, startLine: n.startLine,
        node_id: n.node_id, content: n.content,
        footnotes: n.footnotes || [], hyperlights: n.hyperlights || [],
        hypercites: n.hypercites || [],
      }));

      const { foundation: parentBook, itemId } = parseSubBookId(subBookId);
      if (!itemId) continue;
      const db = await openDatabase();

      if (itemId.includes('_Fn') || /^Fn\d/.test(itemId)) {
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
export async function closeHyperlitContainer(silent = false, skipPrepare = false) {
  console.log(`[closeHyperlitContainer] ENTER. silent=${silent}, skipPrepare=${skipPrepare}, isClosingContainer=${isClosingContainer}`);
  if (isClosingContainer) {
    console.log('[closeHyperlitContainer] BLOCKED — already closing');
    return;
  }
  isClosingContainer = true;
  try {
    // Check if container exists in DOM before trying to do anything
    // On homepage, there's no hyperlit-container element
    const container = document.getElementById("hyperlit-container");
    if (!container) {
      return; // Nothing to close - container doesn't exist on this page
    }

    // =========================================================================
    // STACK UNWIND: If stacked layers exist, pop them all from top to bottom
    // before closing the base layer.
    // =========================================================================
    try {
      const { getDepth, popTopLayer, clear: clearStack } = await import('./stack.js');
      // Pop all dynamic layers (depth > 1 means there are stacked layers above base)
      while (getDepth() > 1) {
        await popTopLayer();
      }
      // Clear the base layer entry from the stack (if any)
      clearStack();

      // Clear legacy hyperlitContainer state and strip ?cs= URL param.
      // Must run in both silent and non-silent modes — otherwise stale state
      // survives into cross-book transitions and triggers false restores.
      // NOTE: containerStack is intentionally PRESERVED — it's needed for
      // back-nav restoration. The cross-book popstate handler reads it
      // from the restored entry before delegating to BookToBookTransition.
      const currentState = history.state || {};
      const hasCsParam = new URLSearchParams(window.location.search).has('cs');
      if (currentState.hyperlitContainer || hasCsParam || (!silent && currentState.containerStack)) {
        const cleanState = {
          ...currentState,
          hyperlitContainer: null,
          // Normal close: user dismissed the container — clear stale stack so
          // refresh doesn't re-open.  Silent close (cross-book nav): preserve
          // for back-nav restoration.
          ...(silent ? {} : { containerStack: null, containerStackBookId: null }),
        };
        if (hasCsParam) {
          const cleanParams = new URLSearchParams(window.location.search);
          cleanParams.delete('cs');
          const cleanSearch = cleanParams.toString() ? `?${cleanParams.toString()}` : '';
          const cleanUrl = window.location.pathname + cleanSearch + window.location.hash;
          history.replaceState(cleanState, '', cleanUrl);
        } else {
          history.replaceState(cleanState, '');
        }
      }
    } catch (err) {
      console.warn('Stack unwind error (non-fatal):', err);
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
        // skipPrepare=true when called from saveAndCloseHyperlitContainer (already prepped)
        if (!skipPrepare) {
          await prepareContainerClose();
        }

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

        // Clean up URL hash and history state when closing container
        // If silent=true, the browser has already restored the URL via popstate — skip URL update
        if (!silent) {
          const currentUrl = window.location;
          const pathSegments = currentUrl.pathname.split('/').filter(Boolean);
          const bookSlug = pathSegments[0] || '';

          // Check if any path segments after the book slug are cascade segments (HL_ or Fn)
          const hasCascadeSegments = pathSegments.slice(1).some(seg =>
            seg.startsWith('HL_') || seg.includes('_Fn') || /^Fn\d/.test(seg)
          );

          // Check for hyperlit-related hash or container-stack query param
          const hasHyperlitHash = currentUrl.hash && (
            currentUrl.hash.startsWith('#HL_') || currentUrl.hash.startsWith('#hypercite_') ||
            currentUrl.hash.startsWith('#footnote_') || currentUrl.hash.startsWith('#citation_')
          );
          const hasCsParam = new URLSearchParams(currentUrl.search).has('cs');

          // Always clear container state from history
          const currentState = history.state || {};
          const newState = { ...currentState, hyperlitContainer: null };

          if (hasCascadeSegments || hasHyperlitHash || hasCsParam) {
            // Strip cascade segments from path + remove ?cs param
            const cleanParams = new URLSearchParams(currentUrl.search);
            cleanParams.delete('cs');
            const cleanSearch = cleanParams.toString() ? `?${cleanParams.toString()}` : '';
            const cleanUrl = hasCascadeSegments
              ? `/${bookSlug}${cleanSearch}`
              : `${currentUrl.pathname}${cleanSearch}`;
            console.log('🔗 Cleaning up URL:', currentUrl.pathname + currentUrl.search, '→', cleanUrl);
            history.replaceState(newState, '', cleanUrl);
          } else {
            // URL already clean — just clear the stale history state
            history.replaceState(newState, '');
          }
        }

        console.log('[HyperlitContainer] ✅ Container closed successfully');
      } catch (error) {
        console.warn('Could not fully clean up hyperlit container:', error);
      }
      // NOTE: closeContainer() moved to outer finally so it runs even if hyperlitManager was null
    }
  } finally {
    isClosingContainer = false;
    // ALWAYS deactivate overlay + unlock scroll, even if cleanup threw or hyperlitManager was null
    console.log('[closeHyperlitContainer] FINALLY — calling closeContainer()');
    document.body.classList.remove('hyperlit-container-open');

    // Remove cascade-origin glow from base mark element
    const cascadeOrigin = document.querySelector('.cascade-origin');
    if (cascadeOrigin) {
      cascadeOrigin.classList.remove('cascade-origin');
    }
    clearCascadeOriginId();
    if (hyperlitManager?.closeContainer) {
      hyperlitManager.closeContainer();
    }
  }
}

/**
 * Save and close the hyperlit container with progress overlay
 * Shows "Saving..." overlay while waiting for IndexedDB save to complete
 * Prevents data loss when closing container during active edit mode
 */
export async function saveAndCloseHyperlitContainer() {
  console.log(`[saveAndClose] ENTER. isClosing=${isClosing}, isOpen=${hyperlitManager?.isOpen}`);
  if (isClosing) { console.log('[saveAndClose] BLOCKED by isClosing'); return; }
  if (!hyperlitManager?.isOpen) { console.log('[saveAndClose] BLOCKED by !isOpen'); return; }
  isClosing = true;

  try {
    console.log('[HyperlitContainer] saveAndCloseHyperlitContainer() called');

    // Check if we're in edit mode with pending changes
    if (!window.isEditing) {
      console.log('[HyperlitContainer] Reader mode - closing without save');
      await closeHyperlitContainer(false, true);
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

      // Now safe to close the container (skipPrepare - already prepped above)
      await closeHyperlitContainer(false, true);

    } catch (error) {
      console.error('[HyperlitContainer] Error during save and close:', error);

      // Hide overlay even if there was an error
      await ProgressOverlayConductor.hide();

      // Still try to close the container (skipPrepare - already prepped or failed)
      await closeHyperlitContainer(false, true);
    }
  } finally {
    isClosing = false;
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
