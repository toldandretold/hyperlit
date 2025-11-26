/**
 * Large Paste Handler
 *
 * Handles paste operations with >10 nodes using JSON conversion and batch writes.
 * Converts blocks to JSON, writes to IndexedDB, syncs to PostgreSQL immediately.
 */

import { getNextIntegerId, generateNodeId } from '../../utilities/IDfunctions.js';
import { NODE_LIMIT } from '../../chunkManager.js';
import {
  getNodeChunksAfter,
  deleteNodeChunksAfter,
  writeNodeChunks
} from '../../indexedDB/index.js';
import { showSpinner, showError } from '../../components/editIndicator.js';
import { processContentForFootnotesAndReferences } from '../fallback-processor.js';
import { parseHtmlToBlocks } from '../utils/html-block-parser.js';

/**
 * Handle large paste operations (>10 nodes)
 * @param {Event} event - Paste event
 * @param {Object} insertionPoint - Insertion point data
 * @param {string} pastedContent - Content to paste
 * @param {boolean} isHtmlContent - Whether content is HTML
 * @param {string} formatType - Detected format type
 * @param {Array} extractedFootnotes - Processor-extracted footnotes
 * @param {Array} extractedReferences - Processor-extracted references
 * @returns {Promise<Array>} - Array of written chunks
 */
export async function handleLargePaste(
  event,
  insertionPoint,
  pastedContent,
  isHtmlContent = false,
  formatType = 'general',
  extractedFootnotes = [],
  extractedReferences = []
) {
  event.preventDefault();

  // --- 1. USE PROCESSOR-EXTRACTED FOOTNOTES AND REFERENCES ---
  let processedContent = pastedContent;

  // If footnotes/references were already extracted by the processor, use them
  // Otherwise, fall back to the old extraction method
  if (extractedFootnotes.length === 0 && extractedReferences.length === 0) {
    try {
      console.log(`📝 No footnotes/references from processor, using fallback extractor...`);
      const result = await processContentForFootnotesAndReferences(pastedContent, insertionPoint.book, isHtmlContent, formatType);
      processedContent = result.processedContent;
      extractedFootnotes = result.footnotes;
      extractedReferences = result.references;
      console.log(`✅ Extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);
    } catch (error) {
      console.error('❌ Error processing footnotes/references:', error);
      processedContent = pastedContent; // Fallback to original content on error
    }
  } else {
    console.log(`✅ Using processor-extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);
  }

  // --- 2. HANDLE H1 REPLACEMENT LOGIC ---
  const selection = window.getSelection();
  const currentElement = document.getElementById(insertionPoint.beforeNodeId);
  const isH1 = currentElement && currentElement.tagName === 'H1';

  // Check if pasted content contains block-level elements
  let hasBlockElements = false;
  if (isH1 && processedContent) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = processedContent;
    hasBlockElements = tempDiv.querySelector('p, h1, h2, h3, h4, h5, h6, div, blockquote, ul, ol, pre') !== null;
  }

  // Only replace H1 if there's a selection AND pasting block-level content
  const isH1Selected = isH1 && selection.toString().trim().length > 0 && hasBlockElements;

  if (isH1Selected) {
    console.log(`H1#${currentElement.id} is selected and pasting block-level content - replacing it entirely`);

    // Store the H1's ID before removing it
    const h1Id = currentElement.id;

    // Find the element BEFORE this H1 (to use as new insertion point)
    let beforeElement = currentElement.previousElementSibling;
    while (beforeElement && (!beforeElement.id || !/^\d+(\.\d+)*$/.test(beforeElement.id))) {
      beforeElement = beforeElement.previousElementSibling;
    }

    // Remove H1 from DOM
    currentElement.remove();

    // Delete H1 from IndexedDB
    const { deleteIndexedDBRecord } = await import('../../indexedDB/index.js');
    await deleteIndexedDBRecord(insertionPoint.book, h1Id);

    // Update insertion point to be after the element before the deleted H1
    // (so pasted content takes the place of the deleted H1)
    insertionPoint.beforeNodeId = beforeElement ? beforeElement.id : "0";
    insertionPoint.currentNodeId = beforeElement ? beforeElement.id : "0";
    insertionPoint.afterNodeId = insertionPoint.afterNodeId; // Keep existing afterNodeId

    console.log('Updated insertion point for H1 replacement:', insertionPoint);
  }

  // --- 3. DATA LAYER: Calculate all database changes ---
  const { book, beforeNodeId, afterNodeId } = insertionPoint;
  const textBlocks = isHtmlContent
    ? parseHtmlToBlocks(processedContent)
    : processedContent.split(/\n\s*\n/).filter((blk) => blk.trim());
  if (!textBlocks.length) return [];

  // ✅ FIX: Get existing tail nodes FIRST before assigning any IDs
  console.log(`🔍 [PASTE] Getting existing chunks after node ${beforeNodeId}...`);
  const existingTailChunks = afterNodeId != null
    ? await getNodeChunksAfter(book, beforeNodeId)
    : [];
  console.log(`📊 [PASTE] Retrieved ${existingTailChunks.length} existing tail chunks:`,
    existingTailChunks.map(c => `ID=${c.startLine} node_id=${c.node_id?.slice(-10)}`));

  // Now assign IDs to pasted nodes, knowing what exists
  let currentChunkId = insertionPoint.chunkId;
  let nodesInCurrentChunk = insertionPoint.currentChunkNodeCount;
  let currentStartLine = Math.floor(parseFloat(beforeNodeId));

  const newChunks = textBlocks.map((block, index) => {
    // Rotate chunk if needed
    if (nodesInCurrentChunk >= NODE_LIMIT) {
      currentChunkId = parseInt(getNextIntegerId(currentChunkId)); // Parse to number
      nodesInCurrentChunk = 0;
    }

    // Assign new ID with 100-unit gap
    currentStartLine += 100;
    const startLine = currentStartLine;

    // Generate fresh node_id UUID (never reuse from clipboard)
    const node_id = generateNodeId(book);

    // Convert text to HTML with IDs
    const trimmed = block.trim();
    let content;
    if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
      // It's HTML - add/update the ID and data-node-id on the first element
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = trimmed;
      const firstElement = tempDiv.querySelector('*');
      if (firstElement) {
        firstElement.id = startLine.toString();
        firstElement.setAttribute('data-node-id', node_id);
        content = tempDiv.innerHTML;
      } else {
        content = trimmed;
      }
    } else {
      // Plain text - wrap in paragraph
      content = `<p id="${startLine}" data-node-id="${node_id}">${trimmed}</p>`;
    }

    // Validate that content starts with an HTML element, not raw text
    const temp = document.createElement('div');
    temp.innerHTML = content;
    if (temp.firstChild && temp.firstChild.nodeType !== Node.ELEMENT_NODE) {
      console.warn(`⚠️ Chunk ${index} at line ${startLine} has non-element firstChild:`, {
        nodeType: temp.firstChild.nodeType,
        nodeName: temp.firstChild.nodeName,
        content: content.substring(0, 100)
      });
    }

    nodesInCurrentChunk++;

    console.log(`📝 [PASTE] Pasted node ${index}: startLine=${startLine}, node_id=${node_id.slice(-10)}`);

    return {
      book,
      startLine,
      chunk_id: currentChunkId,
      content,
      node_id,
      hyperlights: [],
      hypercites: [],
      footnotes: [],
    };
  });

  const maxNewLine = Math.max(...newChunks.map(c => c.startLine));
  console.log(`✅ [PASTE] Created ${newChunks.length} pasted chunks with IDs up to ${maxNewLine}`);

  // Renumber tail chunks to come AFTER pasted nodes
  let toWrite = newChunks;
  if (existingTailChunks.length > 0) {
    const tailChunks = existingTailChunks.map((origChunk, idx) => {
      if (nodesInCurrentChunk >= NODE_LIMIT) {
        currentChunkId = parseInt(getNextIntegerId(currentChunkId)); // Parse to number
        nodesInCurrentChunk = 0;
      }

      // Assign new startLine after all pasted nodes
      const newStart = maxNewLine + ((idx + 1) * 100);
      const updatedContent = origChunk.content.replace(
        /id="\d+(\.\d+)?"/g,
        `id="${newStart}"`
      );

      console.log(`  🔄 [TAIL RENUMBER] Chunk ${idx}: ${origChunk.startLine} → ${newStart} (node_id=${origChunk.node_id?.slice(-10)})`);
      nodesInCurrentChunk++;

      return {
        ...origChunk,
        startLine: newStart,
        chunk_id: currentChunkId,
        content: updatedContent,
      };
    });

    console.log(`✅ [TAIL RENUMBER] Created ${tailChunks.length} tail chunks with new IDs:`,
      tailChunks.map(c => `ID=${c.startLine}`));

    toWrite = [...newChunks, ...tailChunks];
    console.log(`📝 [FINAL] Total chunks to write: ${toWrite.length} (${newChunks.length} pasted + ${tailChunks.length} tail)`);
  }

  console.log(`Writing ${toWrite.length} chunks to IndexedDB`);
  await writeNodeChunks(toWrite);

  // Save extracted footnotes and references to IndexedDB
  if (extractedFootnotes.length > 0 || extractedReferences.length > 0) {
    const { saveAllFootnotesToIndexedDB, saveAllReferencesToIndexedDB } = await import('../../indexedDB/index.js');

    if (extractedFootnotes.length > 0) {
      console.log(`💾 Saving ${extractedFootnotes.length} footnotes to IndexedDB...`);
      await saveAllFootnotesToIndexedDB(extractedFootnotes, insertionPoint.book);
    }

    if (extractedReferences.length > 0) {
      console.log(`💾 Saving ${extractedReferences.length} references to IndexedDB...`);
      await saveAllReferencesToIndexedDB(extractedReferences, insertionPoint.book);
    }
  }

  // For paste operations, sync immediately to PostgreSQL using bulk upsert
  // (Don't use debounced queue - that's for individual edits)
  console.log(`📤 Immediately syncing ${toWrite.length} pasted chunks to PostgreSQL...`);

  // Show orange indicator while syncing
  showSpinner();

  try {
    const response = await fetch('/api/db/node-chunks/targeted-upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
      },
      credentials: 'include',
      body: JSON.stringify({
        book: insertionPoint.book,
        data: toWrite
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Failed to sync paste to PostgreSQL:', error);
      showError(); // Show red indicator on failure
    } else {
      const result = await response.json();
      console.log('✅ Paste synced to PostgreSQL:', result);
      // Don't call showTick() here - wait until entire paste operation completes
    }
  } catch (error) {
    console.error('❌ Error syncing paste to PostgreSQL:', error);
    showError(); // Show red indicator on exception
  }

  // Invalidate TOC cache after paste (heading IDs have changed)
  const { invalidateTocCache } = await import('../../components/toc.js');
  invalidateTocCache();
  console.log('🔄 TOC cache invalidated after paste');

  return toWrite;
}
