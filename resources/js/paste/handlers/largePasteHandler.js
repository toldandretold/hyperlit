/**
 * Large Paste Handler
 *
 * Handles paste operations with >10 nodes using JSON conversion and batch writes.
 * Converts blocks to JSON, writes to IndexedDB, syncs to PostgreSQL immediately.
 */

import { getNextIntegerId } from '../../utilities/IDfunctions.js';
import { NODE_LIMIT } from '../../chunkManager.js';
import {
  getNodeChunksAfter,
  deleteNodeChunksAfter,
  writeNodeChunks
} from '../../indexedDB/index.js';
import { showSpinner, showError } from '../../components/editIndicator.js';
import { processContentForFootnotesAndReferences } from '../fallback-processor.js';
import { parseHtmlToBlocks } from '../utils/html-block-parser.js';
import { convertToJsonObjects } from '../utils/content-converter.js';

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

  const { jsonObjects: newJsonObjects, state } = convertToJsonObjects(
    textBlocks,
    insertionPoint
  );
  const newChunks = newJsonObjects.map((obj, index) => {
    const key = Object.keys(obj)[0];
    const { content, startLine, chunk_id, node_id } = obj[key];

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

    return {
      book: insertionPoint.book,
      startLine,
      chunk_id,
      content,
      node_id,  // Include node_id for stable tracking
      hyperlights: [],
      hypercites: [],
      footnotes: [],
    };
  });

  let toWrite = newChunks;
  if (afterNodeId != null) {
    const newLines = newJsonObjects.map(
      (o) => o[Object.keys(o)[0]].startLine
    );
    const maxNewLine = Math.max(...newLines);
    const existingChunks = await getNodeChunksAfter(book, afterNodeId);
    let currentChunkId = state.currentChunkId;
    let nodesInCurrentChunk = state.nodesInCurrentChunk;
    const tailChunks = existingChunks.map((origChunk, idx) => {
      if (nodesInCurrentChunk >= NODE_LIMIT) {
        currentChunkId = getNextIntegerId(currentChunkId);
        nodesInCurrentChunk = 0;
      }
      // Use 100-unit gaps for tail renumbering too (consistent with paste and renumbering system)
      const newStart = maxNewLine + ((idx + 1) * 100);
      const updatedContent = origChunk.content.replace(
        /id="\d+"/g,
        `id="${newStart}"`
      );
      nodesInCurrentChunk++;
      return {
        ...origChunk,
        startLine: newStart,
        chunk_id: currentChunkId,
        content: updatedContent,
      };
    });
    toWrite = [...newChunks, ...tailChunks];
    await deleteNodeChunksAfter(book, afterNodeId);
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
    const response = await fetch('/api/db/node-chunks/upsert', {
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
