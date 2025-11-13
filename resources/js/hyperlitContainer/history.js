/**
 * History & Navigation Management
 * Handles URL hashes and browser history for hyperlit container state
 */

import { detectHypercites, detectHighlights } from './detection.js';
import { buildUnifiedContent, handlePostOpenActions } from './index.js';
import { openHyperlitContainer, hyperlitManager } from './core.js';

/**
 * Determine URL hash for single content types
 * Returns null for multiple content types (overlapping content)
 * @param {Array} contentTypes - Array of content type objects
 * @returns {string|null} URL hash string or null
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
        return `hypercite_${cleanId}`;
      }
      break;

    case 'highlight':
      if (contentType.highlightIds && contentType.highlightIds.length === 1) {
        return contentType.highlightIds[0]; // Already has HL_ prefix
      }
      break;

    case 'footnote':
      if (contentType.elementId) {
        return `footnote_${contentType.elementId}`;
      }
      break;

    case 'citation':
      if (contentType.referenceId) {
        return `citation_${contentType.referenceId}`;
      }
      break;
  }

  return null;
}

/**
 * Restore hyperlit container from history state
 * @returns {Promise<boolean>} True if successfully restored
 */
export async function restoreHyperlitContainerFromHistory() {
  const historyState = history.state;

  if (!historyState || !historyState.hyperlitContainer) {
    console.log('📊 No hyperlit container state found in history');
    return false;
  }

  const containerState = historyState.hyperlitContainer;
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
      // Build and open the container
      const unifiedContent = await buildUnifiedContent(contentTypes, containerState.newHighlightIds || []);
      openHyperlitContainer(unifiedContent, true); // isBackNavigation = true

      // Handle post-open actions
      await handlePostOpenActions(contentTypes, containerState.newHighlightIds || []);

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

  if (!hyperlitManager || !document.getElementById('hyperlit-container')?.style.display ||
      document.getElementById('hyperlit-container').style.display === 'none') {
    return null;
  }

  // Try to extract state from current container content
  // This is a fallback method - ideally state should be tracked during opening
  const container = document.getElementById('hyperlit-container');
  if (!container) return null;

  // Return basic state (full implementation would extract more details)
  return {
    isOpen: true,
    timestamp: Date.now()
  };
}
