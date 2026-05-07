/**
 * History & Navigation Management
 * Handles URL hashes and browser history for hyperlit container state
 */

import { detectHypercites, detectHighlights } from './detection.js';
import { buildUnifiedContent, handlePostOpenActions, checkIfUserHasAnyEditPermission } from './index.js';
import { prepareHyperlitContainer, animateHyperlitContainerOpen, hyperlitManager, getHyperlitEditMode } from './core.js';
import { openDatabase } from '../indexedDB/index.js';
import { getCurrentContainer } from './stack.js';

/**
 * Determine URL update for single content types
 * Returns null for multiple content types (overlapping content)
 * @param {Array} contentTypes - Array of content type objects
 * @returns {Object|null} { type: 'hash'|'path', value: string, hash?: string } or null
 */
export function determineSingleContentHash(contentTypes) {
  if (contentTypes.length !== 1) {
    return null; // Multiple content types - don't update URL
  }

  const contentType = contentTypes[0];

  switch (contentType.type) {
    case 'hypercite':
      if (contentType.hyperciteId) {
        // Remove hypercite_ prefix if present, then add it back for consistency
        const cleanId = contentType.hyperciteId.replace(/^hypercite_/, '');
        return { type: 'hash', value: `hypercite_${cleanId}` };
      }
      break;

    case 'highlight':
      if (contentType.highlightIds && contentType.highlightIds.length === 1) {
        return { type: 'hash', value: contentType.highlightIds[0] }; // Already has HL_ prefix
      }
      break;

    case 'footnote':
      if (contentType.elementId || contentType.footnoteId) {
        // Footnotes use path-based URLs: /book/footnoteID
        // Hash portion is reserved for hypercite within footnote: /book/footnoteID#hyperciteID
        // detectFootnote() returns footnoteId; direct-ID detection uses elementId — support both
        return { type: 'path', value: contentType.elementId || contentType.footnoteId };
      }
      break;

    case 'citation':
      if (contentType.referenceId) {
        return { type: 'hash', value: `citation_${contentType.referenceId}` };
      }
      break;

    case 'hypercite-citation':
      if (contentType.element?.id) {
        return { type: 'hash', value: contentType.element.id };
      }
      break;
  }

  return null;
}

/**
 * Build content from serialized containerState metadata.
 * Re-fetches content types from IndexedDB, checks edit permissions,
 * and builds the unified HTML. Shared by all restoration paths.
 *
 * @param {Object} containerState - Serialized container state with contentTypes array
 * @returns {Promise<{html: string, contentTypes: Array, newHighlightIds: Array, hasAnyEditPermission: boolean}|null>}
 */
export async function buildContentFromMetadata(containerState) {
  if (!containerState?.contentTypes?.length) return null;

  // Reconstruct content types from stored state
  const contentTypes = [];

  for (const storedType of containerState.contentTypes) {
    let contentType = { ...storedType };

    // For hypercites, we might need to refetch some data
    if (storedType.type === 'hypercite' && storedType.hyperciteId) {
      const hyperciteData = await detectHypercites(null, storedType.hyperciteId);
      if (hyperciteData) {
        contentType = hyperciteData;
      }
    }

    // For highlights, refetch if we have IDs
    if (storedType.type === 'highlight' && storedType.highlightIds) {
      const highlightData = await detectHighlights(null, storedType.highlightIds);
      if (highlightData) {
        contentType = highlightData;
      }
    }

    contentTypes.push(contentType);
  }

  if (contentTypes.length === 0) return null;

  const db = await openDatabase();
  const newHighlightIds = containerState.newHighlightIds || [];
  const editModeEnabled = getHyperlitEditMode();
  const hasAnyEditPermission = await checkIfUserHasAnyEditPermission(contentTypes, newHighlightIds, db);

  const html = await buildUnifiedContent(contentTypes, newHighlightIds, db, editModeEnabled, hasAnyEditPermission);

  return { html, contentTypes, newHighlightIds, hasAnyEditPermission };
}

/**
 * Restore hyperlit container from history state (layer 0).
 * After opening, pushes layer 0 into the stack.
 *
 * @param {Object} providedContainerState - Optional container state (if not provided, reads from history.state)
 * @param {boolean} skipUrlUpdate - Whether to skip URL hash update (used when toggling edit mode)
 * @param {boolean} skipAutoFocus - Skip auto-focus (used when edit button handles focus separately)
 * @returns {Promise<boolean>} True if successfully restored
 */
export async function restoreHyperlitContainerFromHistory(providedContainerState = null, skipUrlUpdate = false, skipAutoFocus = false) {
  // Use provided state or fall back to history.state
  let containerState = providedContainerState;

  if (!containerState) {
    const historyState = history.state;
    if (!historyState || !historyState.hyperlitContainer) {
      console.log('📊 No hyperlit container state found in history');
      return false;
    }
    containerState = historyState.hyperlitContainer;
  }
  console.log('📊 Restoring hyperlit container from history:', containerState);

  try {
    const result = await buildContentFromMetadata(containerState);
    if (!result) return false;

    const { html, contentTypes, newHighlightIds, hasAnyEditPermission } = result;

    // Two-phase open: prepare off-screen → load content → animate in
    prepareHyperlitContainer(html, true); // isBackNavigation = true
    const baseContainerEl = document.getElementById('hyperlit-container');
    await handlePostOpenActions(contentTypes, newHighlightIds, null, false, hasAnyEditPermission, skipAutoFocus, null, { containerEl: baseContainerEl });
    animateHyperlitContainerOpen();

    // Push layer 0 into the stack
    const { pushLayer, syncStackToHistoryState, isEmpty: isStackEmpty } = await import('./stack.js');
    if (isStackEmpty()) {
      pushLayer({
        depth: 0,
        container: document.getElementById('hyperlit-container'),
        overlay: document.getElementById('ref-overlay'),
        scroller: document.querySelector('#hyperlit-container .scroller'),
        isDynamic: false,
        savedModuleState: null,
        savedSubBookState: null,
        savedEditMode: getHyperlitEditMode(),
        contentMetadata: containerState,
      });
      syncStackToHistoryState();
    }

    console.log('✅ Successfully restored hyperlit container from history');
    return true;
  } catch (error) {
    console.error('❌ Error restoring hyperlit container from history:', error);
  }

  return false;
}

/**
 * Restore a single stacked layer from serialized metadata.
 * Mirrors pushStackedLayer but builds content from metadata instead of a clicked element.
 *
 * @param {Object} containerState - Serialized container state for this layer
 * @returns {Promise<boolean>} True if successfully restored
 */
export async function restoreStackedLayer(containerState) {
  if (!containerState?.contentTypes?.length) return false;

  try {
    const {
      pushLayer, getDepth, getTopLayer,
      createStackedContainerDOM, syncStackToHistoryState,
      getCurrentContainer: getContainer, getCurrentScroller: getScroller,
    } = await import('./stack.js');
    const { setHyperlitEditMode } = await import('./core.js');
    const { saveSubBookState, resetSubBookState } = await import('./subBookLoader.js');
    const { detachNoteListeners } = await import('./noteListener.js');
    const {
      saveModuleState, restoreModuleState, resetModuleState,
    } = await import('./index.js');

    // --- 1. Pause current layer: flush saves, stop editor, detach listeners ---
    const { flushInputDebounce, flushAllPendingSaves } = await import('../divEditor/index.js');
    flushInputDebounce();
    await flushAllPendingSaves();

    const { getActiveEditSession } = await import('../divEditor/editSessionManager.js');
    const activeSession = getActiveEditSession();
    if (activeSession && activeSession.containerId !== 'main-content') {
      const { stopObserving } = await import('../divEditor/index.js');
      await stopObserving();
    }

    detachNoteListeners();

    // --- 2. Snapshot module state ---
    const savedModuleState = saveModuleState();
    const savedSubBookState = saveSubBookState();
    const savedEditMode = getHyperlitEditMode();

    resetSubBookState();

    // --- 3. Update saved state on the current top layer ---
    const currentContainer = getContainer();
    const topLayer = getTopLayer();
    if (topLayer && topLayer.savedModuleState === null) {
      topLayer.savedModuleState = savedModuleState;
      topLayer.savedSubBookState = savedSubBookState;
      topLayer.savedEditMode = savedEditMode;
    }

    // Disable pointer events on the now-lower layer
    if (currentContainer) {
      currentContainer.style.pointerEvents = 'none';
    }

    // --- 4. Reset module state for the new layer ---
    resetModuleState();
    setHyperlitEditMode(savedEditMode);

    // --- 5. Create new DOM elements ---
    const newDepth = getDepth();
    const { container: newContainer, overlay: newOverlay, scroller: newScroller } = createStackedContainerDOM(newDepth);

    // Attach overlay click handler to pop this layer
    newOverlay.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const { popTopLayer } = await import('./stack.js');
      await popTopLayer();
    });

    // Push the new layer entry
    pushLayer({
      depth: newDepth,
      container: newContainer,
      overlay: newOverlay,
      scroller: newScroller,
      isDynamic: true,
      savedModuleState: null,
      savedSubBookState: null,
      savedEditMode: savedEditMode,
      contentMetadata: containerState,
    });

    // --- 6. Build content from metadata and render ---
    const result = await buildContentFromMetadata(containerState);
    if (!result) {
      console.warn('📚 No content built for stacked layer restore, aborting');
      return false;
    }

    const { html, contentTypes, newHighlightIds, hasAnyEditPermission } = result;
    newScroller.innerHTML = html;

    // Set max-height dynamically
    const viewportHeight = window.innerHeight;
    newContainer.style.maxHeight = `${viewportHeight - 16 - 4}px`;

    // Lock body scroll
    document.body.classList.add('hyperlit-container-open');

    // Animate the container open
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        newContainer.classList.add('open');
      });
    });

    // Handle post-open actions
    await handlePostOpenActions(contentTypes, newHighlightIds, null, false, hasAnyEditPermission, true, null, { containerEl: newContainer });

    // Sync stack to history.state
    syncStackToHistoryState();

    console.log(`📚 Stacked layer ${newDepth} restored successfully`);
    return true;
  } catch (error) {
    console.error('❌ Error restoring stacked layer:', error);
    return false;
  }
}

/**
 * Restore an entire container stack from serialized data.
 * Single entry point for all restoration (popstate, refresh, SPA transition).
 *
 * @param {Array} stack - Array of serialized layer objects from history.state.containerStack
 * @returns {Promise<boolean>} True if successfully restored
 */
export async function restoreContainerStack(stack) {
  if (!stack?.length) return false;

  console.log(`📚 Restoring container stack (${stack.length} layers)...`);

  // Layer 0: restore via existing path (opens base container + pushes layer 0)
  const restored = await restoreHyperlitContainerFromHistory(stack[0].contentMetadata);
  if (!restored) return false;

  // Layers 1+: restore via direct stacking
  for (let i = 1; i < stack.length; i++) {
    // Wait for sub-book content to load before stacking the next layer
    await new Promise(r => setTimeout(r, 300));
    const ok = await restoreStackedLayer(stack[i].contentMetadata);
    if (!ok) {
      console.warn(`📚 Stack restoration stopped at layer ${i}`);
      break;
    }
  }

  console.log('📚 Container stack restoration complete');
  return true;
}

/**
 * Get current container state for preservation during navigation
 * Returns null if no container is open
 * @returns {Object|null} Current container state or null
 */
export async function getCurrentContainerState() {
  // Already imported statically

  if (!hyperlitManager || !getCurrentContainer()?.style.display ||
      getCurrentContainer().style.display === 'none') {
    return null;
  }

  // Try to extract state from current container content
  // This is a fallback method - ideally state should be tracked during opening
  const container = getCurrentContainer();
  if (!container) return null;

  // Return basic state (full implementation would extract more details)
  return {
    isOpen: true,
    timestamp: Date.now()
  };
}
