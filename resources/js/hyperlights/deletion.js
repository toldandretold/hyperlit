/**
 * Deletion module - Handles highlight deletion, hiding, and reprocessing
 */

import { openDatabase, updateBookTimestamp, queueForSync, getNodeChunksFromIndexedDB } from '../indexedDB/index.js';
import { removeHighlightFromHyperlights, removeHighlightFromNodeChunks, removeHighlightFromNodeChunksWithDeletion } from './database.js';
import { attachMarkListeners } from './listeners.js';

/**
 * Unwrap a mark element, preserving its content
 * @param {HTMLElement} mark - The mark element to unwrap
 */
export function unwrapMark(mark) {
  if (!mark || !mark.parentNode) return;
  const parent = mark.parentNode;
  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);

  // ✅ normalize here, since parent is available
  if (typeof parent.normalize === "function") {
    parent.normalize();
  }
}

/**
 * Delete a highlight by ID
 * @param {string} highlightId - The highlight ID to delete
 * @returns {Promise<Object>} Deletion result with affected nodes
 */
export async function deleteHighlightById(highlightId) {
  try {
    console.log(`🗑️ Deleting highlight by ID: ${highlightId}`);

    // Get the highlight data first to determine the book
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");

    const getRequest = idx.get(highlightId);
    const highlightData = await new Promise((resolve, reject) => {
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
    });

    if (!highlightData) {
      throw new Error(`Highlight not found: ${highlightId}`);
    }

    const bookId = highlightData.book;
    console.log(`📚 Found highlight in book: ${bookId}`);

    // Remove the highlight class from DOM marks, but preserve other classes
    const markElements = document.querySelectorAll(`mark.${highlightId}`);
    const affectedNodeIds = new Set();

    markElements.forEach(mark => {
      // Remove just this highlight's class
      mark.classList.remove(highlightId);

      // If this was the main mark (with id), remove the id too
      if (mark.id === highlightId) {
        mark.removeAttribute('id');
      }

      // If no more highlight classes remain, remove the mark entirely
      const remainingHighlights = Array.from(mark.classList).filter(cls => cls.startsWith('HL_'));

        if (remainingHighlights.length === 0) {
          unwrapMark(mark);
        } else {
        // Still has other highlights - just update the styling
        console.log(`Mark still has highlights: ${remainingHighlights.join(', ')}`);
        // Update highlight count and intensity if needed
        const highlightCount = remainingHighlights.length;
        mark.setAttribute('data-highlight-count', highlightCount);
        const intensity = Math.min(highlightCount / 5, 1);
        mark.style.setProperty('--highlight-intensity', intensity);
      }

      // Track which nodes were affected for re-applying highlights
      const container = mark.closest('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id]');
      if (container && container.id) {
        affectedNodeIds.add(container.id);
      }
    });

    // Remove from IndexedDB
    const deletedHyperlight = await removeHighlightFromHyperlights(highlightId);
    const affectedNodes = await removeHighlightFromNodeChunksWithDeletion(bookId, highlightId, deletedHyperlight);

    // Update book timestamp
    await updateBookTimestamp(bookId);

    // Queue for server sync
    if (deletedHyperlight) {
      queueForSync("hyperlights", highlightId, "delete", deletedHyperlight);
    }

    // 🔄 OLD SYSTEM: COMMENTED OUT - Don't queue node updates
    /*
    affectedNodes.forEach((chunk) => {
      if (chunk && chunk.startLine) {
        queueForSync("nodes", chunk.startLine, "update", chunk);
      }
    });
    */

    console.log(`✅ Successfully deleted highlight: ${highlightId}`);
    console.log(`📝 Affected nodes: ${Array.from(affectedNodeIds).join(', ')}`);

    return {
      success: true,
      affectedNodes: Array.from(affectedNodeIds),
      deletedHighlight: deletedHyperlight
    };

  } catch (error) {
    console.error(`❌ Error deleting highlight ${highlightId}:`, error);
    throw error;
  }
}

/**
 * Hide a highlight by ID - removes from IndexedDB and DOM but sets hidden=true in database
 * @param {string} highlightId - The highlight ID to hide
 * @returns {Promise<Object>} Hide result with affected nodes
 */
export async function hideHighlightById(highlightId) {
  console.log(`🙈 Hiding highlight by ID: ${highlightId}`);

  try {
    // Get the highlight data first to determine the book
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");

    const getRequest = idx.get(highlightId);
    let highlightData = null;

    await new Promise((resolve, reject) => {
      getRequest.onsuccess = () => {
        highlightData = getRequest.result;
        resolve();
      };
      getRequest.onerror = () => reject(getRequest.error);
    });

    if (!highlightData) {
      throw new Error(`Highlight not found: ${highlightId}`);
    }

    const bookId = highlightData.book;
    console.log(`📚 Found highlight in book: ${bookId}`);

    // Remove the highlight class from DOM marks, but preserve other classes (same as delete)
    const markElements = document.querySelectorAll(`mark.${highlightId}`);
    const affectedNodeIds = new Set();

    markElements.forEach(mark => {
      // Remove just this highlight's class
      mark.classList.remove(highlightId);

      // If this was the main mark (with id), remove the id too
      if (mark.id === highlightId) {
        mark.removeAttribute('id');
      }

      // If no more highlight classes remain, remove the mark entirely
      const remainingHighlights = Array.from(mark.classList).filter(cls => cls.startsWith('HL_'));

      if (remainingHighlights.length === 0) {
        const parentNode = mark.parentNode;
        unwrapMark(mark);
        if (parentNode) parentNode.normalize();
      } else {
        // Still has other highlights - just update the styling
        console.log(`Mark still has highlights: ${remainingHighlights.join(', ')}`);
        // Update highlight count and intensity if needed
        const highlightCount = remainingHighlights.length;
        mark.setAttribute('data-highlight-count', highlightCount);
        const intensity = Math.min(highlightCount / 5, 1);
        mark.style.setProperty('--highlight-intensity', intensity);
      }

      // Track which nodes were affected for re-applying highlights
      const container = mark.closest('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id]');
      if (container && container.id) {
        affectedNodeIds.add(container.id);
      }
    });

    // For hide: Only remove from IndexedDB locally, DON'T touch PostgreSQL nodes
    // Remove from local IndexedDB hyperlights table
    const hiddenHyperlight = await removeHighlightFromHyperlights(highlightId);

    // Remove from local IndexedDB nodes (but don't sync this change to PostgreSQL)
    await removeHighlightFromNodeChunks(bookId, highlightId);

    // Update book timestamp locally
    await updateBookTimestamp(bookId);

    // Queue ONLY the hide operation for sync to PostgreSQL - no nodeChunk updates
    if (hiddenHyperlight) {
      // Pass the highlight data for the sync to work
      queueForSync("hyperlights", highlightId, "hide", hiddenHyperlight);
    }

    // DON'T queue nodeChunk updates - PostgreSQL nodes should keep the highlight data

    console.log(`✅ Successfully hidden highlight: ${highlightId}`);
    console.log(`📝 Affected nodes: ${Array.from(affectedNodeIds).join(', ')}`);

    return {
      success: true,
      affectedNodes: Array.from(affectedNodeIds),
      hiddenHighlight: hiddenHyperlight
    };

  } catch (error) {
    console.error(`❌ Error hiding highlight ${highlightId}:`, error);
    throw error;
  }
}

/**
 * Re-process highlights for specific affected nodes after highlight deletion
 * This ensures overlapping highlights are correctly recalculated and displayed
 * @param {string} bookId - The book ID
 * @param {Array<string>} affectedNodeIds - Array of node IDs to reprocess
 */
export async function reprocessHighlightsForNodes(bookId, affectedNodeIds) {
  console.log(`🔄 Reprocessing highlights for nodes:`, affectedNodeIds);

  try {
    const { applyHighlights } = await import('../lazyLoaderFactory.js');

    // Get the updated node chunks which should have the correct hyperlights after deletion
    const nodes = await getNodeChunksFromIndexedDB(bookId);

    // Process each affected node
    for (const nodeId of affectedNodeIds) {
      const nodeElement = document.getElementById(nodeId);
      if (!nodeElement) {
        console.warn(`Node ${nodeId} not found in DOM`);
        continue;
      }

      // Find the node data with its current highlights
      const nodeData = nodes.find(chunk => chunk.startLine == nodeId);
      if (!nodeData) {
        console.warn(`Node data not found for ${nodeId}`);
        continue;
      }

      // Get highlights that apply to this node from the node data
      const nodeHighlights = nodeData.hyperlights || [];

      console.log(`Node ${nodeId} has ${nodeHighlights.length} remaining highlights after deletion`);

      if (nodeHighlights.length === 0) {
        // No highlights left - just remove all marks
        const existingMarks = nodeElement.querySelectorAll('mark[class*="HL_"]');
        existingMarks.forEach(mark => {
          const parent = mark.parentNode;
          parent.replaceChild(document.createTextNode(mark.textContent), mark);
          parent.normalize();
        });
        console.log(`No highlights remaining for node ${nodeId} - removed all marks`);
        continue;
      }

      // Get the plain text content by removing existing marks
      let plainText = nodeElement.textContent || '';

      // Remove all existing marks from this node
      const existingMarks = nodeElement.querySelectorAll('mark[class*="HL_"]');
      existingMarks.forEach(mark => {
        unwrapMark(mark);
        mark.parentNode?.normalize();
      });

      // Get the clean HTML and re-apply highlights with correct segmentation
      const cleanHtml = nodeElement.innerHTML;
      console.log(`Applying highlights to clean HTML for node ${nodeId}:`, nodeHighlights.map(h => h.highlightID));
      let newHtml = applyHighlights(cleanHtml, nodeHighlights, bookId);

      // ✅ CRITICAL: Also re-apply hypercites (same order as lazy loader)
      // Without this, hypercite <u> tags are stripped when innerHTML is replaced
      const nodeHypercites = nodeData.hypercites || [];
      if (nodeHypercites.length > 0) {
        console.log(`Also applying ${nodeHypercites.length} hypercites to node ${nodeId}`);
        const { applyHypercites } = await import('../lazyLoaderFactory.js');
        newHtml = applyHypercites(newHtml, nodeHypercites);
      }

      console.log(`Original HTML length: ${cleanHtml.length}, New HTML length: ${newHtml.length}`);
      console.log(`Clean HTML: ${cleanHtml.substring(0, 100)}...`);
      console.log(`New HTML: ${newHtml.substring(0, 100)}...`);

      nodeElement.innerHTML = newHtml;

      // Verify the highlights were applied
      const appliedMarks = nodeElement.querySelectorAll('mark[class*="HL_"]');
      console.log(`✅ Reprocessed highlights for node ${nodeId}: ${nodeHighlights.length} highlights, ${appliedMarks.length} marks applied`);
    }

    // Re-attach mark listeners to the new elements
    attachMarkListeners();

    // ✅ Re-attach hypercite listeners to the new elements
    // innerHTML replacement destroys and recreates DOM elements, losing their event listeners
    const { attachUnderlineClickListeners } = await import('../hypercites/index.js');
    attachUnderlineClickListeners();

    console.log(`✅ Completed reprocessing highlights for ${affectedNodeIds.length} nodes`);

  } catch (error) {
    console.error(`❌ Error reprocessing highlights:`, error);
    throw error;
  }
}
