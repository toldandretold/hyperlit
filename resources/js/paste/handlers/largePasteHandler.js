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
  writeNodeChunks,
  getNodeChunksFromIndexedDB
} from '../../indexedDB/index.js';
import { glowCloudOrange, glowCloudRed } from '../../components/editIndicator.js';
import { processContentForFootnotesAndReferences } from '../fallback-processor.js';
import { parseHtmlToBlocks } from '../utils/html-block-parser.js';
import { ProgressOverlayConductor } from '../../navigation/ProgressOverlayConductor.js';
import { sanitizeHtml } from '../../utilities/sanitizeConfig.js';
import { extractFootnoteIdsFromHtml } from '../utils/extractFootnoteIds.js';
import { BLOCK_ELEMENT_SELECTOR } from '../../utilities/blockElements.js';

// Snapshot for undo support
let lastPasteSnapshot = null;

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

  // Wait for background download if still in progress (chunked lazy loading)
  if (window._backgroundDownloadInProgress) {
    const { waitForBackgroundDownload } = await import('../../backgroundDownloader.js');
    await waitForBackgroundDownload();
  }

  // Show progress overlay for large paste operation
  ProgressOverlayConductor.showSPATransition(10, 'Processing paste...', true);

  // --- 1. USE PROCESSOR-EXTRACTED FOOTNOTES AND REFERENCES ---
  // Content from processors is already sanitized in base-processor.createDOM()
  // Only the fallback path (below) needs sanitization of its output
  let processedContent = pastedContent;

  // If footnotes/references were already extracted by the processor, use them
  // Otherwise, fall back to the old extraction method
  if (extractedFootnotes.length === 0 && extractedReferences.length === 0) {
    try {
      console.log(`📝 No footnotes/references from processor, using fallback extractor...`);
      // SECURITY: Pass sanitized content to fallback processor
      const result = await processContentForFootnotesAndReferences(processedContent, insertionPoint.book, isHtmlContent, formatType);
      // SECURITY: Re-sanitize result to ensure it's clean
      processedContent = result.processedContent ? sanitizeHtml(result.processedContent) : processedContent;
      extractedFootnotes = result.footnotes;
      extractedReferences = result.references;
      console.log(`✅ Extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);
    } catch (error) {
      console.error('❌ Error processing footnotes/references:', error);
      // SECURITY: Keep sanitized content on error (not raw pastedContent)
      // processedContent already contains sanitized content from line above
    }
  } else {
    console.log(`✅ Using processor-extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);
  }

  // --- 2. HANDLE H1 REPLACEMENT LOGIC ---
  const selection = window.getSelection();
  const currentElement = document.getElementById(insertionPoint.beforeNodeId);
  const isH1 = currentElement && currentElement.tagName === 'H1';

  // Check if pasted content contains block-level elements
  // SECURITY: Use DOMParser instead of innerHTML to prevent XSS during check
  let hasBlockElements = false;
  if (isH1 && processedContent) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(processedContent, 'text/html');
    hasBlockElements = doc.body.querySelector(BLOCK_ELEMENT_SELECTOR) !== null;
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

  // Snapshot all nodes BEFORE any modifications (for undo support)
  const allNodesBeforePaste = await getNodeChunksFromIndexedDB(book);
  lastPasteSnapshot = { bookId: book, allNodes: [...allNodesBeforePaste] };
  console.log(`📸 [PASTE] Snapshot saved: ${allNodesBeforePaste.length} nodes for undo`);

  // Delete old tail nodes from IndexedDB (they'll be re-inserted with new IDs)
  if (afterNodeId != null && existingTailChunks.length > 0) {
    console.log(`🗑️ [PASTE] Deleting ${existingTailChunks.length} old tail chunks from IndexedDB...`);
    await deleteNodeChunksAfter(book, beforeNodeId);
    console.log(`✅ [PASTE] Old tail chunks deleted from IndexedDB`);
  }

  // Now assign IDs to pasted nodes, knowing what exists
  // IMPORTANT: Don't trust insertionPoint.currentChunkNodeCount - it's from DOM, not IndexedDB
  // We need to count how many nodes are ACTUALLY in this chunk from what we just retrieved
  const allNodesInBook = await getNodeChunksFromIndexedDB(book);
  const actualNodesInInsertionChunk = allNodesInBook.filter(n => n.chunk_id === insertionPoint.chunkId).length;

  let currentChunkId = insertionPoint.chunkId;
  let nodesInCurrentChunk = actualNodesInInsertionChunk;
  let currentStartLine = Math.floor(parseFloat(beforeNodeId));

  console.log(`🔍 [PASTE] Insertion chunk ${currentChunkId} has ${nodesInCurrentChunk} nodes (will rotate if >= ${NODE_LIMIT})`);

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

    // Extract footnote IDs from content (store IDs, not display numbers)
    const footnoteIds = extractFootnoteIdsFromHtml(content);

    nodesInCurrentChunk++;

    return {
      book,
      startLine,
      chunk_id: currentChunkId,
      content,
      node_id,
      hyperlights: [],
      hypercites: [],
      footnotes: footnoteIds,
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

      nodesInCurrentChunk++;

      return {
        ...origChunk,
        startLine: newStart,
        chunk_id: currentChunkId,
        content: updatedContent,
      };
    });

    console.log(`✅ [TAIL RENUMBER] Renumbered ${tailChunks.length} tail nodes`);

    toWrite = [...newChunks, ...tailChunks];
    console.log(`📝 [FINAL] Total chunks to write: ${toWrite.length} (${newChunks.length} pasted + ${tailChunks.length} tail)`);
  }

  console.log(`Writing ${toWrite.length} chunks to IndexedDB`);
  ProgressOverlayConductor.updateProgress(40, 'Saving to IndexedDB...');
  await writeNodeChunks(toWrite);

  // Save extracted footnotes and references to IndexedDB
  if (extractedFootnotes.length > 0 || extractedReferences.length > 0) {
    const { saveAllFootnotesToIndexedDB, saveAllReferencesToIndexedDB } = await import('../../indexedDB/index.js');

    if (extractedFootnotes.length > 0) {
      // Generate preview_nodes + initial sub-book nodes so opening a footnote
      // after paste doesn't hit the synthesize branch (which triggers stuck orange CloudRef).
      const { generateNodeId } = await import('../../utilities/IDfunctions.js');
      const { buildSubBookId } = await import('../../utilities/subBookIdHelper.js');

      const subBookNodes = [];

      for (const fn of extractedFootnotes) {
        const subBookId = buildSubBookId(insertionPoint.book, fn.footnoteId);
        const nodeId = generateNodeId(subBookId);
        const strippedText = (fn.content || '').replace(/<[^>]+>/g, '');
        const nodeContent = `<p data-node-id="${nodeId}" no-delete-id="please" style="min-height:1.5em;">${strippedText}</p>`;

        fn.preview_nodes = [{
          book: subBookId,
          chunk_id: 0,
          startLine: 1,
          node_id: nodeId,
          content: nodeContent,
          footnotes: [],
          hyperlights: [],
          hypercites: [],
        }];

        subBookNodes.push({
          book: subBookId,
          startLine: 1,
          chunk_id: 0,
          node_id: nodeId,
          content: nodeContent,
          hyperlights: [],
          hypercites: [],
        });
      }

      if (subBookNodes.length > 0) {
        await writeNodeChunks(subBookNodes);
      }

      console.log(`💾 Saving ${extractedFootnotes.length} footnotes to IndexedDB...`);
      await saveAllFootnotesToIndexedDB(extractedFootnotes, insertionPoint.book);
    }

    if (extractedReferences.length > 0) {
      console.log(`💾 Saving ${extractedReferences.length} references to IndexedDB...`);
      await saveAllReferencesToIndexedDB(extractedReferences, insertionPoint.book);
    }
  }

  // Invalidate TOC cache after paste (heading IDs have changed)
  const { invalidateTocCache } = await import('../../components/toc.js');
  invalidateTocCache();
  console.log('🔄 TOC cache invalidated after paste');

  // Return data for DOM insertion
  // PostgreSQL sync will happen in background after DOM is visible (in index.js)
  return { chunks: toWrite, book: insertionPoint.book };
}

/**
 * Undo the last large paste by restoring the pre-paste snapshot.
 * Deletes all current nodes, restores snapshot, refreshes lazy loader, syncs to PostgreSQL.
 */
export async function undoLastLargePaste() {
  if (!lastPasteSnapshot) {
    console.warn('No paste snapshot available for undo');
    return;
  }

  const { bookId, allNodes } = lastPasteSnapshot;
  lastPasteSnapshot = null;

  console.log(`⏪ Undoing large paste: restoring ${allNodes.length} nodes for book ${bookId}`);

  // Suppress MutationObserver + integrity checks during undo (same as paste handler)
  const { setPasteInProgress } = await import('../../utilities/operationState.js');
  setPasteInProgress(true);

  ProgressOverlayConductor.showSPATransition(10, 'Undoing paste...', true);

  try {
    // 1. Delete all current nodes for this book
    await deleteNodeChunksAfter(bookId, 0);

    // 2. Restore snapshot nodes
    if (allNodes.length > 0) {
      await writeNodeChunks(allNodes);
    }

    ProgressOverlayConductor.updateProgress(60, 'Refreshing view...');

    // 3. Refresh lazy loader (remove all chunks, reload chunk 0)
    const { initializeMainLazyLoader } = await import('../../initializePage.js');
    const loader = initializeMainLazyLoader();
    loader.nodes = await loader.getNodeChunks();

    const allChunks = Array.from(loader.container.querySelectorAll('[data-chunk-id]'));
    allChunks.forEach(chunk => {
      const chunkId = parseInt(chunk.dataset.chunkId);
      chunk.remove();
      loader.currentlyLoadedChunks.delete(chunkId);
    });

    loader.loadChunk(0, 'down');
    loader.repositionSentinels();

    // Clear browser undo stack — DOM was rebuilt, stale entries would cause phantom saves
    if (loader.container) {
      loader.container.contentEditable = 'false';
      loader.container.contentEditable = 'true';
    }

    await ProgressOverlayConductor.hide();
    console.log('✅ Large paste undo complete');

    // 4. Full book sync to PostgreSQL in background
    const { glowCloudOrange, glowCloudGreen, glowCloudRed } = await import('../../components/editIndicator.js');
    glowCloudOrange();

    const response = await fetch('/api/db/node-chunks/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
      },
      credentials: 'include',
      body: JSON.stringify({ book: bookId, data: allNodes })
    });

    if (response.ok) {
      glowCloudGreen();
      console.log('✅ Paste undo synced to PostgreSQL');
    } else {
      glowCloudRed();
      console.error('❌ Failed to sync paste undo to PostgreSQL');
    }
  } catch (error) {
    console.error('❌ Error undoing large paste:', error);
    await ProgressOverlayConductor.hide();
  } finally {
    setPasteInProgress(false);
  }
}

/**
 * Clear the paste snapshot (e.g. when user makes subsequent edits)
 */
export function clearPasteSnapshot() {
  lastPasteSnapshot = null;
}
