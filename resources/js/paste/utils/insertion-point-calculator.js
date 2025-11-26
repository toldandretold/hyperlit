/**
 * Insertion Point Calculator
 * Calculates where to insert pasted content in the document
 *
 * Features:
 * - Finds current node position in chunk
 * - Identifies before/after nodes for insertion
 * - Tracks chunk node counts
 * - Returns complete insertion context
 */

import { chunkNodeCounts } from '../../chunkManager.js';

/**
 * Calculate insertion point for paste operation
 * Determines where to insert content based on current cursor position
 *
 * @param {HTMLElement} chunkElement - The chunk element containing the cursor
 * @param {string} book - Book identifier
 * @returns {Object|null} - Insertion point data or null if cannot determine
 */
export function getInsertionPoint(chunkElement, book) {
  const selection = window.getSelection();
  const range = selection.getRangeAt(0);
  const currentNode = range.startContainer;

  // Find the current node element (handle text nodes)
  let currentNodeElement = currentNode.nodeType === Node.TEXT_NODE
    ? currentNode.parentElement
    : currentNode;

  // Traverse up to find parent with numerical ID (including decimals)
  while (currentNodeElement && currentNodeElement !== chunkElement) {
    const id = currentNodeElement.id;

    // Check if ID exists and is numerical (including decimals)
    if (id && /^\d+(\.\d+)*$/.test(id)) {
      break; // Found our target element
    }

    // Move up to parent
    currentNodeElement = currentNodeElement.parentElement;
  }

  // If we didn't find a numerical ID, we might be at chunk level or need fallback
  if (!currentNodeElement || !currentNodeElement.id || !/^\d+(\.\d+)*$/.test(currentNodeElement.id)) {
    console.warn('Could not find parent element with numerical ID');
    return null;
  }

  const currentNodeId = currentNodeElement.id;
  const chunkId = chunkElement.dataset.chunkId || chunkElement.id;

  // Current node becomes the beforeNodeId (we're inserting after it)
  const beforeNodeId = currentNodeId;

  // Find the next element with a numerical ID (this is the afterNodeId)
  let afterElement = currentNodeElement.nextElementSibling;

  while (afterElement) {
    if (afterElement.id && /^\d+(\.\d+)*$/.test(afterElement.id)) {
      break;
    }

    afterElement = afterElement.nextElementSibling;
  }

  const afterNodeId = afterElement?.id || null;

  // Use existing chunk tracking
  const currentChunkNodeCount = chunkNodeCounts[chunkId] || 0;

  const result = {
    chunkId: parseInt(chunkId), // Parse to number (not string)
    currentNodeId: currentNodeId,
    beforeNodeId: beforeNodeId,
    afterNodeId: afterNodeId,
    currentChunkNodeCount: currentChunkNodeCount,
    insertionStartLine: parseInt(currentNodeId), // startLine = node ID
    book: book
  };

  console.log(`Insertion point: before=${beforeNodeId}, after=${afterNodeId || 'end'}, chunk=${chunkId}`);
  return result;
}
