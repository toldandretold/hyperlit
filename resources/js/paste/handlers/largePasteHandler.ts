import { asBookId, LATEST, type BookId } from "../../indexedDB/types";
/**
 * Large Paste Handler
 *
 * Handles paste operations with >10 nodes using JSON conversion and batch writes.
 * Converts blocks to JSON, writes to IndexedDB, syncs to PostgreSQL immediately.
 */

import { getNextIntegerId, generateDataNodeId } from '../../utilities/IDfunctions';
import { parseChunkId } from '../../indexedDB/types';
import { getPasteSnapshot, setPasteSnapshot } from '../pasteSnapshot';
export { clearPasteSnapshot } from '../pasteSnapshot';
import { NODE_LIMIT } from '../../utilities/chunkState';
import {
  getNodesAfter,
  deleteNodesAfter,
  writeNodes,
  getNodesFromIndexedDB
} from '../../indexedDB/index';
import { glowCloudOrange, glowCloudRed } from '../../components/cloudRef/editIndicator';
import { processContentForFootnotesAndReferences } from '../fallback-processor';
import { parseHtmlToBlocks } from '../utils/html-block-parser';
import { ProgressOverlayConductor } from '../../SPA/navigation/ProgressOverlayConductor';
import { sanitizeHtml } from '../../utilities/sanitizeConfig';
import { extractFootnoteIdsFromHtml } from '../utils/extractFootnoteIds';
import { BLOCK_ELEMENT_SELECTOR } from '../../utilities/blockElements';

// Snapshot for undo support lives in the ../pasteSnapshot leaf (see clearPasteSnapshot importers).

export interface LargePasteOptions {
  isHtmlContent?: boolean;
  formatType?: string;
  extractedFootnotes?: any[];
  extractedReferences?: any[];
  /** The untouched clipboard HTML, for the fallback extractor. See below. */
  pristineHtml?: string;
}

/**
 * Decide what the fallback extractor's output is allowed to replace.
 *
 * The fallback re-runs the WHOLE GeneralProcessor, so adopting its
 * `processedContent` throws away the publisher processor's ordered tag-stripping.
 * That is right when the format was misdetected (the fallback found the notes
 * the publisher processor could not) and wrong when the article genuinely has
 * no notes (the publisher's cleanup was correct and we would be discarding it
 * for nothing). So: adopt the body only when the fallback actually found
 * something.
 *
 * Pure, so it can be tested without standing up IndexedDB.
 */
export function resolveExtraction(
  current: { content: any; footnotes: any[]; references: any[] },
  fallback: { processedContent?: any; footnotes?: any[]; references?: any[] } | null,
) {
  const footnotes = fallback?.footnotes ?? [];
  const references = fallback?.references ?? [];
  const found = footnotes.length + references.length > 0;

  if (!found) return { ...current, usedFallback: false };

  return {
    content: fallback?.processedContent ? sanitizeHtml(fallback.processedContent) : current.content,
    footnotes,
    references,
    usedFallback: true,
  };
}

/**
 * Handle large paste operations (>10 nodes)
 * @param {Event} event - Paste event
 * @param {Object} insertionPoint - Insertion point data
 * @param {string} pastedContent - Content to paste
 * @param {Object} options - See LargePasteOptions
 * @returns {Promise<Object>} - { chunks, book, footnotes, references, usedFallback }
 */
export async function handleLargePaste(
  event: any,
  insertionPoint: any,
  pastedContent: any,
  options: LargePasteOptions = {}
) {
  const {
    isHtmlContent = false,
    formatType = 'general',
    pristineHtml,
  } = options;
  // Locals, NOT parameters. Reassigning a parameter is invisible to the caller,
  // which is why every fallback-path glitch report used to arrive at triage
  // claiming "Footnotes 0, References 0" while 54 had actually been extracted.
  let extractedFootnotes: any[] = options.extractedFootnotes ?? [];
  let extractedReferences: any[] = options.extractedReferences ?? [];
  let usedFallback = false;

  event.preventDefault();

  // Wait for background download if still in progress (chunked lazy loading)
  if ((window as any)._backgroundDownloadInProgress) {
    const { waitForBackgroundDownload } = await import('../../pageLoad/backgroundDownload');
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
      // Feed it the PRISTINE clipboard HTML, not `processedContent` — that is
      // the format processor's already-transformed output, so the fallback was
      // re-running the whole GeneralProcessor over DOM another processor had
      // stripped and rewritten (prod case book_1787965215968: a Sage-mangled
      // page yielded 13 references built out of body prose).
      const fallbackInput = pristineHtml || processedContent;
      const result = await processContentForFootnotesAndReferences(fallbackInput, insertionPoint.book, isHtmlContent, formatType);
      // SECURITY: re-sanitize any body we adopt.
      const resolved = resolveExtraction(
        { content: processedContent, footnotes: extractedFootnotes, references: extractedReferences },
        result,
      );
      processedContent = resolved.content;
      extractedFootnotes = resolved.footnotes;
      extractedReferences = resolved.references;
      usedFallback = resolved.usedFallback;
      console.log(`✅ Extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);
    } catch (error: any) {
      console.error('❌ Error processing footnotes/references:', error);
      // SECURITY: Keep sanitized content on error (not raw pastedContent)
      // processedContent already contains sanitized content from line above
    }
  } else {
    console.log(`✅ Using processor-extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);
  }

  // --- 2. HANDLE H1 REPLACEMENT LOGIC ---
  const selection: any = window.getSelection();
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
    const { deleteIndexedDBRecord } = await import('../../indexedDB/index');
    await (deleteIndexedDBRecord as any)(insertionPoint.book, h1Id);

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
    : processedContent.split(/\n\s*\n/).filter((blk: any) => blk.trim());
  if (!textBlocks.length) return [];

  // ✅ FIX: Get existing tail nodes FIRST before assigning any IDs
  console.log(`🔍 [PASTE] Getting existing chunks after node ${beforeNodeId}...`);
  const existingTailChunks = afterNodeId != null
    ? await getNodesAfter(book, beforeNodeId)
    : [];
  console.log(`📊 [PASTE] Retrieved ${existingTailChunks.length} existing tail chunks:`,
    existingTailChunks.map((c: any) => `ID=${c.startLine} node_id=${c.node_id?.slice(-10)}`));

  // Snapshot all nodes BEFORE any modifications (for undo support)
  const allNodesBeforePaste = await getNodesFromIndexedDB(book);
  setPasteSnapshot({ bookId: book, allNodes: [...allNodesBeforePaste] });
  console.log(`📸 [PASTE] Snapshot saved: ${allNodesBeforePaste.length} nodes for undo`);

  // Delete old tail nodes from IndexedDB (they'll be re-inserted with new IDs)
  if (afterNodeId != null && existingTailChunks.length > 0) {
    console.log(`🗑️ [PASTE] Deleting ${existingTailChunks.length} old tail chunks from IndexedDB...`);
    await deleteNodesAfter(book, beforeNodeId);
    console.log(`✅ [PASTE] Old tail chunks deleted from IndexedDB`);
  }

  // Now assign IDs to pasted nodes, knowing what exists
  // IMPORTANT: Don't trust insertionPoint.currentChunkNodeCount - it's from DOM, not IndexedDB
  // We need to count how many nodes are ACTUALLY in this chunk from what we just retrieved
  const allNodesInBook = await getNodesFromIndexedDB(book);
  const actualNodesInInsertionChunk = allNodesInBook.filter((n: any) => n.chunk_id === insertionPoint.chunkId).length;

  let currentChunkId = insertionPoint.chunkId;
  let nodesInCurrentChunk = actualNodesInInsertionChunk;
  let currentStartLine = Math.floor(parseFloat(beforeNodeId));

  console.log(`🔍 [PASTE] Insertion chunk ${currentChunkId} has ${nodesInCurrentChunk} nodes (will rotate if >= ${NODE_LIMIT})`);

  const newChunks = textBlocks.map((block: any, index: any) => {
    // Rotate chunk if needed
    if (nodesInCurrentChunk >= NODE_LIMIT) {
      currentChunkId = parseInt(getNextIntegerId(currentChunkId)); // Parse to number
      nodesInCurrentChunk = 0;
    }

    // Assign new ID with 100-unit gap
    currentStartLine += 100;
    const startLine = currentStartLine;

    // Generate fresh node_id UUID (never reuse from clipboard)
    const node_id = generateDataNodeId(book);

    // Convert text to HTML with IDs
    const trimmed = block.trim();
    let content: any;
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

  const maxNewLine = Math.max(...newChunks.map((c: any) => c.startLine));
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
  await writeNodes(toWrite);

  // Save extracted footnotes and references to IndexedDB
  if (extractedFootnotes.length > 0 || extractedReferences.length > 0) {
    const { saveAllFootnotesToIndexedDB, saveAllReferencesToIndexedDB } = await import('../../indexedDB/index');

    if (extractedFootnotes.length > 0) {
      // Generate preview_nodes + initial sub-book nodes so opening a footnote
      // after paste doesn't hit the synthesize branch (which triggers stuck orange CloudRef).
      const { generateDataNodeId } = await import('../../utilities/IDfunctions');
      const { buildSubBookId } = await import('../../utilities/subBookIdHelper');

      const subBookNodes: any[] = [];

      for (const fn of extractedFootnotes) {
        const subBookId = buildSubBookId(insertionPoint.book, fn.footnoteId);
        const nodeId = generateDataNodeId(asBookId(subBookId));
        const strippedText = (fn.content || '').replace(/<[^>]+>/g, '');
        const nodeContent = `<p data-node-id="${nodeId}" style="min-height:1.5em;">${strippedText}</p>`;

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
        await writeNodes(subBookNodes);
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
  const { invalidateTocCache } = await import('../../components/tocContainer/index');
  invalidateTocCache();
  console.log('🔄 TOC cache invalidated after paste');

  // Return data for DOM insertion
  // PostgreSQL sync will happen in background after DOM is visible (in index.js)
  // The counts travel back so the caller's conversion summary reflects what was
  // ACTUALLY extracted — the fallback path used to be invisible from outside.
  return {
    chunks: toWrite,
    book: insertionPoint.book,
    footnotes: extractedFootnotes,
    references: extractedReferences,
    usedFallback,
  };
}

/**
 * Undo the last large paste by restoring the pre-paste snapshot.
 * Deletes all current nodes, restores snapshot, refreshes lazy loader, syncs to PostgreSQL.
 */
export async function undoLastLargePaste() {
  const snapshot = getPasteSnapshot();
  if (!snapshot) {
    console.warn('No paste snapshot available for undo');
    return;
  }

  const { bookId, allNodes } = snapshot;
  setPasteSnapshot(null);

  console.log(`⏪ Undoing large paste: restoring ${allNodes.length} nodes for book ${bookId}`);

  // Suppress MutationObserver + integrity checks during undo (same as paste handler)
  const { setPasteInProgress } = await import('../../utilities/operationState');
  setPasteInProgress(true);

  ProgressOverlayConductor.showSPATransition(10, 'Undoing paste...', true);

  try {
    // 1. Delete all current nodes for this book
    await deleteNodesAfter(bookId, 0);

    // 2. Restore snapshot nodes
    if (allNodes.length > 0) {
      await writeNodes(allNodes);
    }

    ProgressOverlayConductor.updateProgress(60, 'Refreshing view...');

    // 3. Refresh lazy loader (remove all chunks, reload chunk 0)
    const { initializeMainLazyLoader } = await import('../../pageLoad/index');
    const loader = initializeMainLazyLoader();
    loader.nodes = await loader.getNodes();

    const allChunks = Array.from<any>(loader.container.querySelectorAll('[data-chunk-id]'));
    allChunks.forEach((chunk: any) => {
      // parseChunkId = parseFloat (NOT parseInt): currentlyLoadedChunks holds decimal
      // chunk_ids, so a truncating delete would miss a fractional entry.
      const chunkId = parseChunkId(chunk.dataset.chunkId);
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
    const { glowCloudOrange, glowCloudGreen, glowCloudRed } = await import('../../components/cloudRef/editIndicator');
    glowCloudOrange();

    const response = await fetch('/api/db/nodes/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content
      },
      credentials: 'include',
      body: JSON.stringify({ book: bookId, data: allNodes })
    });

    if (response.ok) {
      glowCloudGreen();
      console.log('✅ Paste undo synced to PostgreSQL');
    } else {
      glowCloudRed({ status: response.status, savedLocally: false });
      console.error('❌ Failed to sync paste undo to PostgreSQL');
    }
  } catch (error: any) {
    console.error('❌ Error undoing large paste:', error);
    await ProgressOverlayConductor.hide();
  } finally {
    setPasteInProgress(false);
  }
}

/**
 * Clear the paste snapshot (e.g. when user makes subsequent edits)
 */
// clearPasteSnapshot is re-exported from ../pasteSnapshot (top of file).
