/**
 * History & Navigation Management
 * Handles URL hashes and browser history for hyperlit container state
 */

import { detectHypercites, detectHighlights } from './detection.js';
import { buildUnifiedContent, handlePostOpenActions, checkIfUserHasAnyEditPermission } from './index.js';
import { openHyperlitContainer, hyperlitManager, getHyperlitEditMode } from './core.js';
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
      if (contentType.elementId) {
        // Footnotes use path-based URLs: /book/footnoteID
        // Hash portion is reserved for hypercite within footnote: /book/footnoteID#hyperciteID
        return { type: 'path', value: contentType.elementId };
      }
      break;

    case 'citation':
      if (contentType.referenceId) {
        return { type: 'hash', value: `citation_${contentType.referenceId}` };
      }
      break;
  }

  return null;
}

/**
 * Restore hyperlit container from history state
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
    // Import dependencies dynamically to avoid circular imports
    // Already imported statically
    // Already imported statically
    // Already imported statically

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

    if (contentTypes.length > 0) {
      // Get edit mode state and permission info
      const db = await openDatabase();
      const newHighlightIds = containerState.newHighlightIds || [];
      const editModeEnabled = getHyperlitEditMode();
      const hasAnyEditPermission = await checkIfUserHasAnyEditPermission(contentTypes, newHighlightIds, db);

      // Build and open the container with edit mode state
      const unifiedContent = await buildUnifiedContent(contentTypes, newHighlightIds, db, editModeEnabled, hasAnyEditPermission);
      openHyperlitContainer(unifiedContent, true); // isBackNavigation = true

      // Handle post-open actions with edit permission info
      await handlePostOpenActions(contentTypes, newHighlightIds, null, false, hasAnyEditPermission, skipAutoFocus);

      console.log('✅ Successfully restored hyperlit container from history');
      return true;
    }
  } catch (error) {
    console.error('❌ Error restoring hyperlit container from history:', error);
  }

  return false;
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
