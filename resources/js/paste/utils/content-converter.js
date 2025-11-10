/**
 * Content Conversion Utilities
 * Converts pasted content into the internal JSON format for storage
 *
 * Features:
 * - Converts text blocks to JSON objects with IDs
 * - Handles chunk rotation when NODE_LIMIT is reached
 * - Generates stable node IDs for tracking
 * - Wraps plain text in HTML paragraphs
 */

import { NODE_LIMIT } from '../../chunkManager.js';
import { getNextIntegerId, generateNodeId } from "../../utilities/IDfunctions.js";

/**
 * Convert text blocks to JSON objects for storage
 * Assigns IDs, manages chunk rotation, and creates structured data
 *
 * @param {Array<string>} textBlocks - Array of text/HTML blocks
 * @param {Object} insertionPoint - Insertion point data from insertion-point-calculator
 * @returns {Object} - { jsonObjects, state } where state contains currentChunkId, nodesInCurrentChunk, beforeId
 */
export function convertToJsonObjects(textBlocks, insertionPoint) {
  const jsonObjects = [];

  let currentChunkId       = insertionPoint.chunkId;
  let nodesInCurrentChunk  = insertionPoint.currentChunkNodeCount;
  let beforeId             = insertionPoint.beforeNodeId;
  const afterId            = insertionPoint.afterNodeId;

  textBlocks.forEach((block) => {
    // rotate chunk?
    if (nodesInCurrentChunk >= NODE_LIMIT) {
      currentChunkId      = getNextIntegerId(currentChunkId);
      nodesInCurrentChunk = 0;
    }

    // Generate new node ID with 100-unit gaps (like renumbering system)
    const beforeNum = Math.floor(parseFloat(beforeId));
    const newNodeId = (beforeNum + 100).toString();

    // Generate stable node_id for this pasted node
    const nodeId = generateNodeId(insertionPoint.book);

    const trimmed     = block.trim();
    const htmlContent = convertTextToHtml(trimmed, newNodeId, nodeId);

    const key = `${insertionPoint.book},${newNodeId}`;
    jsonObjects.push({
      [key]: {
        content:   htmlContent,
        startLine: parseFloat(newNodeId),
        chunk_id:  parseFloat(currentChunkId),
        node_id:   nodeId  // Store node_id for tracking through renumbering
      }
    });

    // advance
    beforeId            = newNodeId;
    nodesInCurrentChunk++;
  });

  return {
    jsonObjects,
    state: {
      currentChunkId,
      nodesInCurrentChunk,
      beforeId
    }
  };
}

/**
 * Convert text to HTML with IDs
 * If content is already HTML, adds IDs to first element
 * If plain text, wraps in paragraph with IDs
 *
 * @param {string} content - Content to convert
 * @param {string} startLineId - The ID to assign (numerical string)
 * @param {string} nodeId - The data-node-id to assign
 * @returns {string} - HTML string with IDs
 */
export function convertTextToHtml(content, startLineId, nodeId) {
  // Check if content is already HTML
  if (content.trim().startsWith('<') && content.trim().endsWith('>')) {
    // It's HTML - add/update the ID and data-node-id on the first element
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;

    // Find the first element and give it the IDs
    const firstElement = tempDiv.querySelector('*');
    if (firstElement) {
      firstElement.id = startLineId;
      firstElement.setAttribute('data-node-id', nodeId);
      return tempDiv.innerHTML;
    }

    // Fallback if no elements found
    return content;
  } else {
    // It's plain text - wrap in paragraph with both id and data-node-id
    return `<p id="${startLineId}" data-node-id="${nodeId}">${content}</p>`;
  }
}
