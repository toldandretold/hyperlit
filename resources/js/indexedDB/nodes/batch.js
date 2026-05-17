/**
 * Node Batch Operations Module
 * Handles bulk updates and deletes of node chunks with highlights and hypercites
 */

import { openDatabase } from '../core/connection.js';
import { parseNodeId } from '../core/utilities.js';
import { verbose } from '../../utilities/logger.js';
import { syncFirstNodeToTitle, updateBookTimestamp } from '../core/library.js';
import { debounce } from '../../divEditor/saveQueue.js';
import { extractFootnoteIdsFromElement } from '../../paste/utils/extractFootnoteIds.js';
import { withPending } from '../../utilities/operationState.js';
import { queueForSync } from '../syncQueue/queue.js';
import { reportIntegrityFailure } from '../../integrity/reporter.js';
import { INLINE_SKIP_TAGS } from '../../utilities/blockElements.js';
// Pure helper extracted so the DOM-walk + fallback chain can be unit-tested
// in isolation. Tests: tests/javascript/indexedDB/batch.test.js
import { resolveBookIdForBatch } from './bookIdResolver.js';

export { resolveBookIdForBatch };

// Dependencies that change per-book
let book;

// Initialization function to inject dependencies
export function initNodeBatchDependencies(deps) {
  book = deps.book;
}

// Debounced title sync - only runs 500ms after user stops typing
const debouncedTitleSync = debounce((bookId, nodeContent) => {
  syncFirstNodeToTitle(bookId, nodeContent).catch(error => {
    console.error('❌ Error in debounced title sync:', error);
  });
}, 500);

/**
 * Helper function to determine chunk_id from the DOM
 * Looks for parent chunk div since data-chunk-id is on the chunk, not individual nodes
 */
function determineChunkIdFromDOM(IDnumerical) {
  const node = document.getElementById(IDnumerical);
  if (node) {
    // Look for parent chunk div (data-chunk-id is on the chunk, not the node)
    const chunkDiv = node.closest('.chunk[data-chunk-id]');
    if (chunkDiv) {
      const chunkIdAttr = chunkDiv.getAttribute('data-chunk-id');
      if (chunkIdAttr) {
        return parseInt(chunkIdAttr);
      }
    }
  }
  return 0; // Default fallback
}

/**
 * Process node content to extract highlights, hypercites, and clean content
 * This removes <mark> and <u> tags while preserving their positions
 *
 * @param {HTMLElement} node - DOM node to process
 * @param {Array} existingHypercites - Existing hypercites for merge
 * @returns {Object} Object with content, hyperlights, and hypercites
 */
function processNodeContentHighlightsAndCites(node, existingHypercites = []) {
  const hyperlights = [];
  const hypercites = [];

  // Create a text representation of the node to calculate positions
  const textContent = node.textContent;

  // Function to find the text position of an element within its parent
  function findElementPosition(element, parent) {
    // Create a TreeWalker to walk through all text nodes
    const walker = document.createTreeWalker(
      parent,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let position = 0;
    let currentNode;

    // Walk through all text nodes until we find one that's inside our target element
    while ((currentNode = walker.nextNode())) {
      // If this text node is inside our target element, we've found the start
      if (element.contains(currentNode) || element === currentNode) {
        return position;
      }

      // Otherwise, add this text node's length to our position counter
      position += currentNode.textContent.length;
    }

    return -1; // Element not found
  }

  // Process <mark> tags for hyperlights
  const markTags = node.getElementsByTagName("mark");
  Array.from(markTags).forEach((mark) => {
    // ✅ WHITELIST: Only save marks that have a class starting with "HL_"
    // This prevents ephemeral marks (search highlights, etc.) from being saved
    const hasHLClass = Array.from(mark.classList).some(cls => cls.startsWith('HL_'));
    if (!hasHLClass) {
      return; // Only save proper user highlights
    }

    // ⚠️ SKIP newly created highlights - they already have correct positions from selection.js
    // Rangy may have created incorrect mark boundaries for overlapping highlights
    if (mark.hasAttribute('data-new-hl')) {
      console.log(`⏭️ Skipping position recalculation for newly created highlight ${mark.id} (has data-new-hl attribute)`);
      return; // Don't recalculate positions for newly created highlights
    }

    const startPos = findElementPosition(mark, node);
    const highlightLength = mark.textContent.length;

    if (startPos >= 0) {
      hyperlights.push({
        highlightID: mark.id,
        charStart: startPos,
        charEnd: startPos + highlightLength,
      });

      console.log("Calculated hyperlight positions:", {
        id: mark.id,
        text: mark.textContent,
        startPos,
        endPos: startPos + highlightLength,
        totalNodeLength: textContent.length,
      });
    }
  });

  // Process <u> tags for hypercites
  const uTags = node.getElementsByTagName("u");
  Array.from(uTags).forEach((uTag) => {
    // FIX: Only process <u> tags that are actual hypercites (have a specific ID format)
    // This prevents plain, non-hypercite <u> tags from being processed and causing errors.
    if (!uTag.id || !uTag.id.startsWith('hypercite_')) {
      return; // Skip this tag if it's not a valid hypercite
    }
    if (uTag.classList.contains('hypercite-tombstone')) return; // ghost — handled below

    const startPos = findElementPosition(uTag, node);
    const uLength = uTag.textContent.length;

    if (startPos >= 0) {
      // ✅ MERGE: Find existing hypercite data or use defaults
      const existingHypercite = existingHypercites.find(hc => hc.hyperciteId === uTag.id);

      hypercites.push({
        hyperciteId: uTag.id,
        charStart: startPos,
        charEnd: startPos + uLength,
        relationshipStatus: existingHypercite?.relationshipStatus || "single",
        citedIN: existingHypercite?.citedIN || [],
        time_since: existingHypercite?.time_since || Math.floor(Date.now() / 1000)
      });

      console.log("Calculated hypercite positions:", {
        id: uTag.id,
        text: uTag.textContent,
        startPos,
        endPos: startPos + uLength,
        totalNodeLength: textContent.length,
      });
    }
  });

  // Process ghost tombstone <a> tags — keep node_id tracking alive for ghosts
  const ghostAnchors = node.querySelectorAll('u.hypercite-tombstone[data-ghost="true"]');
  Array.from(ghostAnchors).forEach((anchor) => {
    if (!anchor.id || !anchor.id.startsWith('hypercite_')) return;

    const existingHypercite = existingHypercites.find(hc => hc.hyperciteId === anchor.id);

    // Ghost tombstones don't need meaningful charStart/charEnd (they're invisible)
    // but we need them in the array so updateHyperciteRecords updates node_id
    hypercites.push({
      hyperciteId: anchor.id,
      charStart: -1,
      charEnd: -1,
      relationshipStatus: 'ghost',
      citedIN: existingHypercite?.citedIN || [],
      time_since: existingHypercite?.time_since || Math.floor(Date.now() / 1000)
    });

    console.log("Tracked ghost tombstone:", {
      id: anchor.id,
      nodeId: node.getAttribute('data-node-id'),
    });
  });

  // Extract footnote references using shared utility
  // Returns objects {id, marker} to support non-numeric markers (*, 23a, etc.)
  const footnotes = extractFootnoteIdsFromElement(node);

  // Extract citation references (author-date citations)
  // These are <a> elements with class="citation-ref" and id starting with "Ref"
  const citations = [];
  const citationLinks = node.querySelectorAll('a.citation-ref[id^="Ref"]');
  citationLinks.forEach((link) => {
    citations.push({
      referenceId: link.id,
      text: link.textContent
    });
  });

  // Create a clone to remove the mark and u tags
  const contentClone = node.cloneNode(true);

  // Remove all <mark> tags from the cloned content while preserving their inner HTML
  const clonedMarkTags = contentClone.getElementsByTagName("mark");
  while (clonedMarkTags.length > 0) {
    const markTag = clonedMarkTags[0];
    // Move all child nodes before the mark tag, preserving HTML structure (including <br>)
    while (markTag.firstChild) {
      markTag.parentNode.insertBefore(markTag.firstChild, markTag);
    }
    // Remove the now-empty mark tag
    markTag.parentNode.removeChild(markTag);
  }

  // Remove all <u> tags from the cloned content while preserving their inner HTML
  const clonedUTags = contentClone.getElementsByTagName("u");
  while (clonedUTags.length > 0) {
    const uTag = clonedUTags[0];
    // Move all child nodes before the u tag, preserving HTML structure (including <br>)
    while (uTag.firstChild) {
      uTag.parentNode.insertBefore(uTag.firstChild, uTag);
    }
    // Remove the now-empty u tag
    uTag.parentNode.removeChild(uTag);
  }

  // 🧹 REMOVE <font> tags (browser artifacts from execCommand)
  // These are inline wrappers the browser creates — unwrap to keep content
  const clonedFontTags = contentClone.getElementsByTagName("font");
  while (clonedFontTags.length > 0) {
    const fontTag = clonedFontTags[0];
    while (fontTag.firstChild) {
      fontTag.parentNode.insertBefore(fontTag.firstChild, fontTag);
    }
    fontTag.parentNode.removeChild(fontTag);
  }

  // 🧹 STRIP duplicate node IDs from inline descendants
  // When content is copy-pasted, inline elements can retain id/data-node-id
  // from their original nodes — these cause duplicate DOM IDs on render
  contentClone.querySelectorAll('[id]').forEach(el => {
    if (el === contentClone) return; // Don't strip the node's own ID
    if (/^\d+(\.\d+)*$/.test(el.id)) {
      el.removeAttribute('id');
      el.removeAttribute('data-node-id');
    }
  });

  // 🧹 REMOVE styled spans before saving (prevents them from being stored)
  const clonedSpans = Array.from(contentClone.querySelectorAll('span[style]'));
  clonedSpans.forEach(span => {
    // Check if span is still in the DOM (not already removed)
    if (span.parentNode) {
      // Move all child nodes before the span, preserving HTML structure (including <br>)
      while (span.firstChild) {
        span.parentNode.insertBefore(span.firstChild, span);
      }
      // Remove the now-empty span
      span.parentNode.removeChild(span);
    }
  });

  // 🧹 STRIP ALL inline style attributes from ALL elements (prevents bloat from copy/paste)
  // Keep our semantic tags clean - styles should come from CSS, not inline attributes
  const allElementsWithStyle = Array.from(contentClone.querySelectorAll('[style]'));
  allElementsWithStyle.forEach(element => {
    element.removeAttribute('style');
  });

  // 🔄 NORMALIZE: Migrate old hypercite format to new single-element format on save
  // Old: <a><sup class="open-icon">↗</sup></a> or flipped <sup class="open-icon"><a>↗</a></sup>
  // New: <a class="open-icon">↗</a>
  contentClone.querySelectorAll('a[href*="#hypercite_"] > sup.open-icon').forEach(sup => {
    const anchor = sup.parentElement;
    anchor.classList.add('open-icon');
    anchor.textContent = '↗';
  });
  contentClone.querySelectorAll('sup.open-icon > a[href*="#hypercite_"]').forEach(anchor => {
    const sup = anchor.parentElement;
    anchor.classList.add('open-icon');
    anchor.textContent = '↗';
    sup.parentNode.insertBefore(anchor, sup);
    sup.remove();
  });

  // 🧹 STRIP navigation classes from ALL elements before saving
  // These are temporary UI classes that shouldn't persist in the database
  // Target: <a>, <u>, and arrow icons (<sup>, <span> with .open-icon)
  const navigationClasses = ['arrow-target', 'hypercite-target', 'hypercite-dimmed'];
  const elementsWithNavClasses = contentClone.querySelectorAll('a, u, .open-icon, sup, span');
  elementsWithNavClasses.forEach(el => {
    navigationClasses.forEach(className => {
      el.classList.remove(className);
    });
  });

  // 🔗 NORMALIZE WORD JOINER before hypercite anchors (prevents line breaks)
  // Ensures all hypercite anchors have a word joiner character (\u2060) immediately before them
  // This prevents the arrow from being orphaned on its own line when text wraps
  const hyperciteAnchors = contentClone.querySelectorAll('a[href*="#hypercite_"]');
  hyperciteAnchors.forEach(anchor => {
    const prevSibling = anchor.previousSibling;
    // Check if previous sibling is a text node ending with word joiner
    if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
      if (!prevSibling.textContent.endsWith('\u2060')) {
        // Add word joiner at the end of the text node
        prevSibling.textContent = prevSibling.textContent + '\u2060';
      }
    } else {
      // No text node before anchor - insert word joiner text node
      const wordJoiner = document.createTextNode('\u2060');
      anchor.parentNode.insertBefore(wordJoiner, anchor);
    }
  });

  // Clean KaTeX-rendered HTML before saving — re-renders from data-math attribute
  const mathElements = contentClone.querySelectorAll('latex, latex-block');
  mathElements.forEach(el => {
    el.textContent = '';
  });

  // 🧹 STRIP broken-image wrappers — the broken-image state is reconstructed
  // at render time via the img error event in lazyLoaderFactory.
  // Saving the wrapper + button to IDB causes: (1) DOMPurify strips the button
  // but KEEP_CONTENT leaves "×" as plain text, (2) the img already has
  // class="broken-image" so the error handler skips it → no delete button.
  contentClone.querySelectorAll('.broken-image-wrapper').forEach(wrapper => {
    const img = wrapper.querySelector('img');
    if (img) {
      img.classList.remove('broken-image');
      img.removeAttribute('alt');
      wrapper.replaceWith(img);
    } else {
      wrapper.remove();
    }
  });

  const result = {
    content: contentClone.outerHTML,
    hyperlights,
    hypercites,
    footnotes,
    citations,
  };
  return result;
}

/**
 * Update hyperlight records in IndexedDB
 * Called during node chunk updates
 */
function updateHyperlightRecords(hyperlights, store, bookId, numericNodeId, syncArray, node) {
  hyperlights.forEach((hyperlight) => {
    const key = [bookId, hyperlight.highlightID];
    const getRequest = store.get(key);

    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;

      // Find the actual mark element to get text content
      const markElement = node.querySelector(`#${hyperlight.highlightID}`);
      const highlightedText = markElement ? markElement.textContent : "";
      const highlightedHTML = markElement ? markElement.outerHTML : "";

      // ✅ NEW: Extract data-node-id from DOM for new schema
      const dataNodeID = node.getAttribute('data-node-id');

      if (existingRecord) {
        // ✅ NEW: Check if this was orphaned and now recovered
        if (existingRecord._orphaned_at) {
          console.log(`🎉 RECOVERED orphaned highlight ${hyperlight.highlightID} - found in DOM after node deletion`);
          delete existingRecord._orphaned_at;
          delete existingRecord._orphaned_from_node;
        }

        // ✅ NEW: Clean up deleted nodes if marked
        if (existingRecord._deleted_nodes && existingRecord._deleted_nodes.length > 0) {
          console.log(`🧹 Cleaning up ${existingRecord._deleted_nodes.length} deleted nodes from highlight ${hyperlight.highlightID}`);

          existingRecord._deleted_nodes.forEach(deletedDataNodeID => {
            // Remove from node_id array
            if (existingRecord.node_id && Array.isArray(existingRecord.node_id)) {
              const beforeLength = existingRecord.node_id.length;
              existingRecord.node_id = existingRecord.node_id.filter(id => id !== deletedDataNodeID);
              if (existingRecord.node_id.length < beforeLength) {
                console.log(`  🗑️ Removed ${deletedDataNodeID} from node_id array`);
              }
            }

            // Remove from charData object
            if (existingRecord.charData && existingRecord.charData[deletedDataNodeID]) {
              delete existingRecord.charData[deletedDataNodeID];
              console.log(`  🗑️ Removed ${deletedDataNodeID} from charData`);
            }
          });

          // Clear the tracking array
          delete existingRecord._deleted_nodes;
          console.log(`✅ Cleanup complete for highlight ${hyperlight.highlightID}`);
        }

        // Update existing record with new positions (OLD schema - backward compat)
        existingRecord.startChar = hyperlight.charStart;
        existingRecord.endChar = hyperlight.charEnd;
        existingRecord.startLine = numericNodeId;
        existingRecord.highlightedText = highlightedText;
        existingRecord.highlightedHTML = highlightedHTML;

        // ✅ NEW: Update NEW schema (node_id array + charData object)
        if (dataNodeID) {
          // Initialize if needed
          if (!existingRecord.node_id || !Array.isArray(existingRecord.node_id)) {
            existingRecord.node_id = [];
          }
          if (!existingRecord.charData || typeof existingRecord.charData !== 'object') {
            existingRecord.charData = {};
          }

          // Add this node to node_id array if not present
          if (!existingRecord.node_id.includes(dataNodeID)) {
            existingRecord.node_id.push(dataNodeID);
            console.log(`➕ Added node ${dataNodeID} to highlight ${hyperlight.highlightID}`);
          }

          // Update charData for this specific node
          existingRecord.charData[dataNodeID] = {
            charStart: hyperlight.charStart,
            charEnd: hyperlight.charEnd
          };

          console.log(`✅ Updated NEW schema for ${hyperlight.highlightID}: node_id=${existingRecord.node_id.length} nodes, charData updated for ${dataNodeID}`);
        }

        store.put(existingRecord);
        syncArray.push(existingRecord);

        console.log(`Updated hyperlight ${hyperlight.highlightID} positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
      } else {
        // SAFETY: Check if this highlight already exists under a different book
        // (prevents duplicates when cross-book ID collisions cause marks to
        // appear in the wrong sub-book's DOM)
        const hlIndex = store.index('hyperlight_id');
        const existCheck = hlIndex.get(hyperlight.highlightID);
        existCheck.onsuccess = () => {
          if (existCheck.result) {
            console.warn(`⚠️ Skipping duplicate: ${hyperlight.highlightID} already exists under book ${existCheck.result.book}`);
            return; // Don't create duplicate
          }

          // Create new record
          const newRecord = {
            book: bookId,
            hyperlight_id: hyperlight.highlightID,
            startChar: hyperlight.charStart,
            endChar: hyperlight.charEnd,
            startLine: numericNodeId,
            highlightedText: highlightedText,
            highlightedHTML: highlightedHTML,
            annotation: "",
            // ✅ NEW: Initialize NEW schema fields
            node_id: dataNodeID ? [dataNodeID] : [],
            charData: dataNodeID ? {
              [dataNodeID]: {
                charStart: hyperlight.charStart,
                charEnd: hyperlight.charEnd
              }
            } : {}
          };

          store.put(newRecord);
          syncArray.push(newRecord);

          console.log(`Created new hyperlight ${hyperlight.highlightID} with positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
          if (dataNodeID) {
            console.log(`✅ Initialized NEW schema: node_id=[${dataNodeID}], charData set`);
          }
        };
      }
    };
  });
}

/**
 * Update hypercite records in IndexedDB
 * Called during node chunk updates
 */
function updateHyperciteRecords(hypercites, store, bookId, syncArray, node) {
  hypercites.forEach((hypercite) => {
    const key = [bookId, hypercite.hyperciteId];
    const getRequest = store.get(key);

    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;

      // Find the actual u element to get text content
      const uElement = node.querySelector(`#${hypercite.hyperciteId}`);
      const hypercitedText = uElement ? uElement.textContent : "";
      const hypercitedHTML = uElement ? uElement.outerHTML : "";

      // ✅ NEW: Extract data-node-id from DOM for new schema
      const dataNodeID = node.getAttribute('data-node-id');

      if (existingRecord) {
        // ✅ NEW: Check if this was orphaned and now recovered
        if (existingRecord._orphaned_at) {
          console.log(`🎉 RECOVERED orphaned hypercite ${hypercite.hyperciteId} - found in DOM after node deletion`);
          delete existingRecord._orphaned_at;
          delete existingRecord._orphaned_from_node;
        }

        // ✅ NEW: Clean up deleted nodes if marked
        if (existingRecord._deleted_nodes && existingRecord._deleted_nodes.length > 0) {
          console.log(`🧹 Cleaning up ${existingRecord._deleted_nodes.length} deleted nodes from hypercite ${hypercite.hyperciteId}`);

          existingRecord._deleted_nodes.forEach(deletedDataNodeID => {
            // Remove from node_id array
            if (existingRecord.node_id && Array.isArray(existingRecord.node_id)) {
              const beforeLength = existingRecord.node_id.length;
              existingRecord.node_id = existingRecord.node_id.filter(id => id !== deletedDataNodeID);
              if (existingRecord.node_id.length < beforeLength) {
                console.log(`  🗑️ Removed ${deletedDataNodeID} from node_id array`);
              }
            }

            // Remove from charData object
            if (existingRecord.charData && existingRecord.charData[deletedDataNodeID]) {
              delete existingRecord.charData[deletedDataNodeID];
              console.log(`  🗑️ Removed ${deletedDataNodeID} from charData`);
            }
          });

          // Clear the tracking array
          delete existingRecord._deleted_nodes;
          console.log(`✅ Cleanup complete for hypercite ${hypercite.hyperciteId}`);
        }

        // Update existing record with new positions (OLD schema - backward compat)
        existingRecord.startChar = hypercite.charStart;
        existingRecord.endChar = hypercite.charEnd;
        existingRecord.hypercitedText = hypercitedText;
        existingRecord.hypercitedHTML = hypercitedHTML;

        // ✅ NEW: Update NEW schema (node_id array + charData object)
        if (dataNodeID) {
          // Initialize if needed
          if (!existingRecord.node_id || !Array.isArray(existingRecord.node_id)) {
            existingRecord.node_id = [];
          }
          if (!existingRecord.charData || typeof existingRecord.charData !== 'object') {
            existingRecord.charData = {};
          }

          // Add this node to node_id array if not present
          if (!existingRecord.node_id.includes(dataNodeID)) {
            existingRecord.node_id.push(dataNodeID);
            console.log(`➕ Added node ${dataNodeID} to hypercite ${hypercite.hyperciteId}`);
          }

          // Update charData for this specific node
          existingRecord.charData[dataNodeID] = {
            charStart: hypercite.charStart,
            charEnd: hypercite.charEnd
          };

          console.log(`✅ Updated NEW schema for ${hypercite.hyperciteId}: node_id=${existingRecord.node_id.length} nodes, charData updated for ${dataNodeID}`);
        }

        store.put(existingRecord);
        syncArray.push(existingRecord);

        console.log(`Updated hypercite ${hypercite.hyperciteId} positions: ${hypercite.charStart}-${hypercite.charEnd}`);
      } else {
        // Create new record
        const newRecord = {
          book: bookId,
          hyperciteId: hypercite.hyperciteId,
          startChar: hypercite.charStart,
          endChar: hypercite.charEnd,
          hypercitedText: hypercitedText,
          hypercitedHTML: hypercitedHTML,
          citedIN: [],
          relationshipStatus: "single",
          time_since: hypercite.time_since || Math.floor(Date.now() / 1000),
          // ✅ NEW: Initialize NEW schema fields
          node_id: dataNodeID ? [dataNodeID] : [],
          charData: dataNodeID ? {
            [dataNodeID]: {
              charStart: hypercite.charStart,
              charEnd: hypercite.charEnd
            }
          } : {}
        };

        store.put(newRecord);
        syncArray.push(newRecord);

        console.log(`Created new hypercite ${hypercite.hyperciteId} with positions: ${hypercite.charStart}-${hypercite.charEnd}`);
        if (dataNodeID) {
          console.log(`✅ Initialized NEW schema: node_id=[${dataNodeID}], charData set`);
        }
      }
    };
  });
}

/**
 * Update a single IndexedDB record from DOM changes.
 * Wrapper around batchUpdateIndexedDBRecords for single-record convenience.
 *
 * @param {Object} record - Record object with id and html
 * @returns {Promise<void>}
 */
export function updateSingleIndexedDBRecord(record, options = {}) {
  return batchUpdateIndexedDBRecords([record], options);
}

/**
 * Batch update multiple IndexedDB records.
 * Core implementation used by updateSingleIndexedDBRecord wrapper.
 *
 * @param {Array} recordsToProcess - Array of record objects
 * @param {Object} options - Optional settings
 * @param {boolean} options.skipFootnoteRenumber - Skip auto-renumbering (caller handles it)
 * @param {boolean} options.skipRedoClear - Skip clearing redo history (for automatic operations like undo/redo)
 * @returns {Promise<void>}
 */
export async function batchUpdateIndexedDBRecords(recordsToProcess, options = {}) {
  // ✅ FIX: When skipHistory is true (internal operations like no-delete-id markers),
  // don't use withPending which triggers the orange indicator, since no server sync will happen
  const wrapper = options.skipHistory ? (fn) => fn() : withPending;

  return wrapper(async () => {
    // ✅ FIX: Get book ID from DOM instead of stale global variable
    // During new book creation, global variable may not be updated yet
    const mainContent = document.querySelector('.main-content');
    const firstRecordEl = document.getElementById(recordsToProcess[0]?.id);
    const bookId = resolveBookIdForBatch({
      optionsBookId: options?.bookId,
      firstRecordEl,
      mainContent,
      globalBook: book,
    });
    console.log(
      `🔄 Batch updating ${recordsToProcess.length} IndexedDB records`,
    );

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodes", "hyperlights", "hypercites", "bibliography"],
      "readwrite",
    );
    const chunksStore = tx.objectStore("nodes");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");

    const allSavedNodeChunks = [];
    const allSavedHyperlights = [];
    const allSavedHypercites = [];
    const originalNodeChunkStates = new Map();

    // This is a critical step: Read all original states BEFORE any writes.
    const readPromises = recordsToProcess.map((record) => {
      return new Promise((resolve) => {
        // ✅ FIX 1: Add a check for a valid record and ID before proceeding.
        if (!record || typeof record.id === "undefined" || record.id === null) {
          console.error(
            "Skipping invalid record in batch update (record or id is null/undefined):",
            record,
          );
          return resolve(); // Resolve the promise to not block the batch.
        }

        const numericNodeId = parseNodeId(record.id);

        // ✅ FIX 2: The most important check. Ensure the parsed ID is a valid number.
        if (isNaN(numericNodeId)) {
          console.error(
            `Skipping batch update for invalid node ID: '${record.id}' which parsed to NaN.`,
          );
          reportIntegrityFailure({
            bookId,
            mismatches: [],
            missingFromIDB: [String(record.id)],
            trigger: 'batch-nan-id',
          });
          return resolve(); // Resolve and skip this invalid record.
        }

        const getReq = chunksStore.get([bookId, numericNodeId]);
        getReq.onsuccess = () => {
          if (getReq.result) {
            originalNodeChunkStates.set(numericNodeId, { ...getReq.result });
          }
          resolve();
        };
        getReq.onerror = (err) => {
          console.error(
            `Error getting record for batch update: ID=${record.id}`,
            err,
          );
          resolve(); // Resolve even on error to not block the whole batch.
        };
      });
    });
    await Promise.all(readPromises);

    // Now, perform the updates
    const processPromises = recordsToProcess.map(async (record) => {
      // ✅ FIX 3: Repeat the same validation here to avoid processing bad data.
      if (!record || typeof record.id === "undefined" || record.id === null) {
        return;
      }
      const numericNodeId = parseNodeId(record.id);
      if (isNaN(numericNodeId)) {
        return;
      }

      let IDnumerical = record.id;
      let node = null;

      // Use node_id (data-node-id) for DOM lookup — unique across all books
      const existingForLookup = originalNodeChunkStates.get(numericNodeId);
      if (existingForLookup?.node_id) {
        node = document.querySelector(`[data-node-id="${existingForLookup.node_id}"]`);
      }

      // Fallback for new nodes (no existing record): scope to book container
      if (!node && bookId) {
        const bookContainer = document.querySelector(`[data-book-id="${bookId}"]`)
          || document.getElementById(bookId);
        if (bookContainer) {
          node = bookContainer.querySelector(`[id="${IDnumerical}"]`);
        }
      }

      // Final fallback: global lookup (main content, no collision risk)
      if (!node) {
        node = document.getElementById(IDnumerical);
      }

      // Skip inline formatting artifacts (e.g. <font id="1"> from copy-paste)
      if (node && INLINE_SKIP_TAGS.has(node.tagName)) {
        console.warn(`⚠️ Skipping batch update – inline element <${node.tagName}> for id ${IDnumerical}`);
        return;
      }

      while (node && !/^\d+(\.\d+)?$/.test(IDnumerical)) {
        node = node.parentElement;
        if (node?.id) IDnumerical = node.id;
      }

      if (!/^\d+(\.\d+)?$/.test(IDnumerical)) {
        console.log(
          `Skipping batch update – no valid parent for ${record.id}`,
        );
        return;
      }

      const finalNumericNodeId = parseNodeId(IDnumerical); // Use the final valid ID
      const existing = originalNodeChunkStates.get(finalNumericNodeId);
      const existingHypercites = existing?.hypercites || [];
      const processedData = node
        ? processNodeContentHighlightsAndCites(node, existingHypercites)
        : null;

      // ✅ EXTRACT node_id from data-node-id attribute
      const nodeIdFromDOM = node ? node.getAttribute('data-node-id') : null;

      // 🔍 DEBUG: Log node_id extraction
      verbose.content(`node_id extraction: record.id=${record.id}, finalNodeId=${IDnumerical}, node=${node?.tagName}, nodeIdFromDOM=${nodeIdFromDOM}`, 'indexedDB/nodes/batch.js');
      if (node && !nodeIdFromDOM) {
        console.warn(`⚠️ Node found but no data-node-id attribute! Element:`, node.outerHTML.substring(0, 200));
      }

      let toSave;
      let removedCitations = []; // Track citations removed from this node
      if (existing) {
        toSave = { ...existing };
        if (processedData) {
          toSave.content = processedData.content;
          // ✅ Update footnotes from extracted data (important for renumbering on delete)
          toSave.footnotes = processedData.footnotes || [];
          // ✅ Update citations from extracted data
          const oldCitations = existing.citations || [];
          const newCitations = processedData.citations || [];
          toSave.citations = newCitations;
          // Detect removed citations (were in old, not in new)
          const newCitationIds = new Set(newCitations.map(c => c.referenceId));
          removedCitations = oldCitations.filter(c => !newCitationIds.has(c.referenceId));
          // ✅ NEW SYSTEM: Don't set arrays here - they'll be rebuilt from normalized tables
          // Keep existing arrays or initialize empty if missing
          if (!toSave.hyperlights) toSave.hyperlights = [];
          if (!toSave.hypercites) toSave.hypercites = [];
        } else {
          toSave.content = record.html || existing.content;
        }
        // ✅ FIX: Determine chunk_id from DOM if not provided
        if (record.chunk_id !== undefined) {
          toSave.chunk_id = record.chunk_id;
        } else {
          toSave.chunk_id = determineChunkIdFromDOM(IDnumerical);
        }
        // ✅ UPDATE node_id from DOM if available
        if (nodeIdFromDOM) {
          toSave.node_id = nodeIdFromDOM;
        }
      } else {
        toSave = {
          book: bookId,
          startLine: finalNumericNodeId,
          chunk_id: record.chunk_id !== undefined ? record.chunk_id : determineChunkIdFromDOM(IDnumerical),
          node_id: nodeIdFromDOM || null,
          content: processedData ? processedData.content : record.html || "",
          footnotes: processedData ? processedData.footnotes : [],
          citations: processedData ? processedData.citations : [],
          hyperlights: processedData ? processedData.hyperlights : [],
          hypercites: processedData ? processedData.hypercites : [],
        };
      }

      // 🔍 DEBUG: Log what's being saved
      verbose.content(`Saving to IndexedDB: startLine=${toSave.startLine}, node_id=${toSave.node_id}, hasContent=${!!toSave.content}`, 'indexedDB/nodes/batch.js');
      chunksStore.put(toSave);
      allSavedNodeChunks.push(toSave);

      if (processedData) {
        updateHyperlightRecords(
          processedData.hyperlights,
          lightsStore,
          bookId,
          finalNumericNodeId,
          allSavedHyperlights,
          node,
        );
        updateHyperciteRecords(
          processedData.hypercites,
          citesStore,
          bookId,
          allSavedHypercites,
          node,
        );
      }
    });
    await Promise.all(processPromises);

    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ Batch IndexedDB update complete");

        // Skip both timestamp update and queueForSync if skipHistory is true
        // (for automatic operations like marker restoration during page load)
        // This prevents spurious syncs that could trigger 409 stale data errors
        if (!options.skipHistory) {
          await updateBookTimestamp(bookId);
          allSavedNodeChunks.forEach((chunk) => {
            const originalChunk = originalNodeChunkStates.get(chunk.startLine);
            queueForSync(
              "nodes",
              chunk.startLine,
              "update",
              chunk,
              originalChunk,
              options.skipRedoClear || false,
            );
          });
          allSavedHyperlights.forEach((hl) => {
            queueForSync("hyperlights", hl.hyperlight_id, "update", hl, null, options.skipRedoClear || false);
          });
          allSavedHypercites.forEach((hc) => {
            queueForSync("hypercites", hc.hyperciteId, "update", hc, null, options.skipRedoClear || false);
          });
        } else {
          console.log(`⏭️ Skipping queueForSync - skipHistory option is true`);
        }

        // Auto-sync first node to library title (only if node 100 was updated)
        const firstNodeChunk = allSavedNodeChunks.find(chunk => chunk.startLine === 100);
        if (firstNodeChunk) {
          console.log('🔄 First node (100) was updated, triggering debounced title sync');
          debouncedTitleSync(bookId, firstNodeChunk.content);
        }

        // ✅ NEW SYSTEM: Rebuild node arrays from normalized tables for all affected nodes
        const affectedDataNodeIDs = allSavedNodeChunks
          .map(chunk => chunk.node_id)
          .filter(Boolean);

        if (affectedDataNodeIDs.length > 0) {
          try {
            const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('../hydration/rebuild.js');
            const allNodes = await getNodesByDataNodeIDs(affectedDataNodeIDs);
            // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
            // node when the same node_id exists in both parent and sub-book.
            const nodes = allNodes.filter(n => n.book === bookId);
            if (nodes.length > 0) {
              await rebuildNodeArrays(nodes);
              console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${nodes.length} nodes after batch update`);
            }
          } catch (error) {
            console.error('❌ NEW SYSTEM: Error rebuilding arrays after batch update:', error);
            // Don't fail the whole operation if rebuild fails
          }
        }

        // 📝 Trigger footnote renumbering after batch update if footnotes were affected
        // Skip if caller handles renumbering (e.g., footnoteInserter.js)
        if (!options.skipFootnoteRenumber) {
          // Compare before/after to detect both additions AND deletions
          const normalizeFootnoteIds = (arr) =>
            (arr || []).map(f => typeof f === 'string' ? f : f?.id).filter(Boolean).sort();
          const nodesWithFootnoteChanges = allSavedNodeChunks.filter(node => {
            const originalNode = originalNodeChunkStates.get(node.startLine);
            const oldIds = normalizeFootnoteIds(originalNode?.footnotes);
            const newIds = normalizeFootnoteIds(node.footnotes);
            // Trigger if footnote count changed (added or deleted) — ID-only comparison ignores format differences
            const changed = oldIds.length !== newIds.length ||
                   JSON.stringify(oldIds) !== JSON.stringify(newIds);
            if (changed) {
              console.log(`📝 Footnote change detected in node ${node.startLine}: ${oldIds.length} → ${newIds.length}`);
            }
            return changed;
          });

          if (nodesWithFootnoteChanges.length > 0) {
            console.log(`📝 Triggering footnote renumbering: ${nodesWithFootnoteChanges.length} nodes with footnote changes`);
            try {
              const { rebuildAndRenumber } = await import('../../footnotes/FootnoteNumberingService.js');
              const { getNodeChunksFromIndexedDB } = await import('../index.js');
              const allNodes = await getNodeChunksFromIndexedDB(bookId);
              if (allNodes && allNodes.length > 0) {
                await rebuildAndRenumber(bookId, allNodes);
              }
            } catch (error) {
              console.error('❌ Error triggering footnote renumbering:', error);
              // Don't fail the whole operation if renumbering fails
            }
          }
        } else {
          console.log(`📝 Skipping auto-renumber (caller handles it)`);
        }

        resolve();
      };
      tx.onerror = (e) => reject(e.target.error);
      tx.onabort = (e) => reject(new Error("Batch transaction aborted"));
    });
  });
}

/**
 * Batch delete multiple IndexedDB records
 *
 * @param {Array} IDnumericals - Array of node IDs to delete
 * @param {Map} deletionMap - Map of IDnumerical -> data-node-id for deleted nodes
 * @param {string} bookId - Book ID to delete from (required for sub-book support)
 * @returns {Promise<void>}
 */
export async function batchDeleteIndexedDBRecords(IDnumericals, deletionMap = new Map(), bookId = null) {
  return withPending(async () => {
    // ✅ FIX: Accept bookId as parameter for sub-book support
    // Fallback to DOM lookup only if not provided (backwards compatibility)
    if (!bookId) {
      const mainContent = document.querySelector('.main-content');
      bookId = mainContent?.id || book || "latest";
    }

    // ✅ OPTIMIZATION: Remove duplicates using Set
    const uniqueIDnumericals = [...new Set(IDnumericals)];
    const duplicatesSkipped = IDnumericals.length - uniqueIDnumericals.length;

    const startTime = Date.now();
    console.log(`🗑️ BATCH DELETE START: ${IDnumericals.length} nodes queued (${uniqueIDnumericals.length} unique${duplicatesSkipped > 0 ? `, ${duplicatesSkipped} duplicates skipped` : ''})`);

    try {
      const db = await openDatabase();

      const tx = db.transaction(
        ["nodes", "hyperlights", "hypercites"],
        "readwrite"
      );

      const chunksStore = tx.objectStore("nodes");
      const lightsStore = tx.objectStore("hyperlights");
      const citesStore = tx.objectStore("hypercites");

      // This object will collect the full data of everything we delete.
      const deletedData = {
        nodes: [],
        hyperlights: [],
        hypercites: []
      };

      let processedCount = 0;
      let errorCount = 0;

      // ✅ OPTIMIZATION: Build lookup sets ONCE for O(1) checks in cursor scans
      const deletedIDnumericals = new Set(uniqueIDnumericals.map(id => parseNodeId(id)).filter(id => !isNaN(id)));
      const deletedDataNodeIDs = new Set(Array.from(deletionMap.values()).filter(Boolean));

      verbose.content(`OPTIMIZATION: Will scan highlights/hypercites once for ${deletedIDnumericals.size} deleted nodes (${deletedDataNodeIDs.size} data-node-ids)`, 'indexedDB/nodes/batch.js');

      // Track which highlights/hypercites we've already processed (avoid N cursor scans)
      let highlightsProcessed = 0;
      let hypercitesProcessed = 0;

      // Process each node ID for deletion
      const deletePromises = uniqueIDnumericals.map(async (IDnumerical, index) => {
        if (!/^\d+(\.\d+)?$/.test(IDnumerical)) {
          console.warn(`❌ Skipping deletion – invalid node ID: ${IDnumerical}`);
          errorCount++;
          return;
        }

        const numericNodeId = parseNodeId(IDnumerical);
        const compositeKey = [bookId, numericNodeId];

        return new Promise((resolve, reject) => {
          const getReq = chunksStore.get(compositeKey);

          getReq.onsuccess = () => {
            const existing = getReq.result;

            if (existing) {
              // ✅ CHANGE 1: Store the original record for the history log.
              // We no longer need the `_deleted: true` flag.
              deletedData.nodes.push(existing); // This is the record to ADD BACK on UNDO

              const deleteReq = chunksStore.delete(compositeKey);
              deleteReq.onsuccess = () => {
                processedCount++;
                resolve();
              };
              deleteReq.onerror = (e) => {
                errorCount++;
                console.error(`❌ Failed to delete ${IDnumerical}:`, e.target.error);
                reject(e.target.error);
              };

              // ✅ OPTIMIZATION: Only scan highlights/hypercites ONCE for the first node
              // All subsequent nodes will be handled in the same scan via Set lookups
              if (index === 0) {
                try {
                  // ✅ OPTIMIZED: Single cursor scan for ALL hyperlights
                  const bookIndex = lightsStore.index("book");
                  const bookRange = IDBKeyRange.only(bookId);
                  const lightReq = bookIndex.openCursor(bookRange);

                  lightReq.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                      const highlight = cursor.value;

                      // ✅ OPTIMIZATION: O(1) Set lookup instead of iterating through each deleted node
                      const affectsDeletedNode =
                        deletedIDnumericals.has(highlight.startLine) || // OLD schema check
                        (highlight.node_id && Array.isArray(highlight.node_id) &&
                         highlight.node_id.some(dataNodeID => deletedDataNodeIDs.has(dataNodeID))); // NEW schema check

                      if (affectsDeletedNode) {
                        highlightsProcessed++;

                        // Find which deleted data-node-id this affects (for tracking)
                        const affectedDataNodeID = highlight.node_id?.find(dataNodeID => deletedDataNodeIDs.has(dataNodeID));

                        // Check if multi-node highlight
                        if (highlight.node_id && highlight.node_id.length > 1) {
                          // Multi-node highlight - mark node for deletion cleanup
                          if (!highlight._deleted_nodes) {
                            highlight._deleted_nodes = [];
                          }
                          if (affectedDataNodeID && !highlight._deleted_nodes.includes(affectedDataNodeID)) {
                            highlight._deleted_nodes.push(affectedDataNodeID);
                          }

                          // Save updated highlight (don't delete it!)
                          cursor.update(highlight);
                        } else {
                          // Single-node highlight - OLD SYSTEM behavior (delete from OLD schema stores)
                          if (deletedIDnumericals.has(highlight.startLine)) {
                            deletedData.hyperlights.push(cursor.value); // Record for undo
                            cursor.delete();
                          } else {
                            // Single-node in NEW schema - mark as orphaned
                            highlight._orphaned_at = Date.now();
                            highlight._orphaned_from_node = affectedDataNodeID || highlight.startLine.toString();

                            // Track deleted node for cleanup
                            if (!highlight._deleted_nodes) {
                              highlight._deleted_nodes = [];
                            }
                            if (affectedDataNodeID && !highlight._deleted_nodes.includes(affectedDataNodeID)) {
                              highlight._deleted_nodes.push(affectedDataNodeID);
                            }

                            cursor.update(highlight);
                          }
                        }
                      }

                      cursor.continue();
                    } else {
                      // Cursor complete - log optimization results (verbose)
                      if (highlightsProcessed > 0) {
                        verbose.content(`OPTIMIZATION: Processed ${highlightsProcessed} highlights in single cursor scan`, 'indexedDB/nodes/batch.js');
                      }
                    }
                  };
                } catch (lightError) {
                  console.warn(`⚠️ Error updating hyperlights:`, lightError);
                }

                try {
                  // ✅ OPTIMIZED: Single cursor scan for ALL hypercites
                  const citeIndex = citesStore.index("book");
                  const citeRange = IDBKeyRange.only(bookId);
                  const citeReq = citeIndex.openCursor(citeRange);

                  citeReq.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                      const hypercite = cursor.value;

                      // ✅ OPTIMIZATION: O(1) Set lookup
                      const affectsDeletedNode =
                        deletedIDnumericals.has(hypercite.startLine) || // OLD schema check
                        (hypercite.node_id && Array.isArray(hypercite.node_id) &&
                         hypercite.node_id.some(dataNodeID => deletedDataNodeIDs.has(dataNodeID))); // NEW schema check

                      if (affectsDeletedNode) {
                        hypercitesProcessed++;

                        // Find which deleted data-node-id this affects
                        const affectedDataNodeID = hypercite.node_id?.find(dataNodeID => deletedDataNodeIDs.has(dataNodeID));

                        // Check if multi-node hypercite
                        if (hypercite.node_id && hypercite.node_id.length > 1) {
                          // Multi-node hypercite - mark node for deletion cleanup
                          if (!hypercite._deleted_nodes) {
                            hypercite._deleted_nodes = [];
                          }
                          if (affectedDataNodeID && !hypercite._deleted_nodes.includes(affectedDataNodeID)) {
                            hypercite._deleted_nodes.push(affectedDataNodeID);
                          }

                          // Save updated hypercite (don't delete it!)
                          cursor.update(hypercite);
                        } else if (deletedIDnumericals.has(hypercite.startLine)) {
                          // OLD SYSTEM - hypercite only in old schema
                          deletedData.hypercites.push(cursor.value); // Record for undo
                          cursor.delete();
                        } else {
                          // Single-node hypercite in NEW schema - mark as orphaned
                          hypercite._orphaned_at = Date.now();
                          hypercite._orphaned_from_node = affectedDataNodeID || hypercite.startLine.toString();

                          // Track deleted node for cleanup
                          if (!hypercite._deleted_nodes) {
                            hypercite._deleted_nodes = [];
                          }
                          if (affectedDataNodeID && !hypercite._deleted_nodes.includes(affectedDataNodeID)) {
                            hypercite._deleted_nodes.push(affectedDataNodeID);
                          }

                          cursor.update(hypercite);
                        }
                      }

                      cursor.continue();
                    } else {
                      // Cursor complete - log optimization results (verbose)
                      if (hypercitesProcessed > 0) {
                        verbose.content(`OPTIMIZATION: Processed ${hypercitesProcessed} hypercites in single cursor scan`, 'indexedDB/nodes/batch.js');
                      }
                    }
                  };
                } catch (citeError) {
                  console.warn(`⚠️ Error updating hypercites:`, citeError);
                }
              }
            } else {
              // Silently skip - node already deleted or never existed
              resolve();
            }
          };

          getReq.onerror = (e) => reject(e.target.error);
        });
      });

      await Promise.all(deletePromises);

      return new Promise((resolve, reject) => {
        tx.oncomplete = async () => {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(`🗑️ BATCH DELETE COMPLETE: ${processedCount} deleted, ${errorCount} failed (${duration}s)`);
          await updateBookTimestamp(bookId);

          // Queue deleted records for PostgreSQL sync
          // ⚠️ DIAGNOSTIC: Log when many nodes are being queued for deletion
          if (deletedData.nodes.length > 10) {
            console.warn(`⚠️ MASS DELETION QUEUED: ${deletedData.nodes.length} nodes`, {
              stack: new Error().stack,
              nodeIds: deletedData.nodes.slice(0, 5).map(n => n.startLine),
              timestamp: Date.now()
            });
          }
          deletedData.nodes.forEach((record) => {
            queueForSync("nodes", record.startLine, "delete", record);
          });
          deletedData.hyperlights.forEach((record) => {
            queueForSync("hyperlights", record.hyperlight_id, "delete", record);
          });
          deletedData.hypercites.forEach((record) => {
            queueForSync("hypercites", record.hyperciteId, "delete", record);
          });

          // ✅ NEW SYSTEM: Rebuild arrays for remaining nodes affected by multi-node highlights/hypercites
          try {
            const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('../index.js');

            // Collect all remaining data-node-ids from deletionMap that weren't deleted
            const deletedDataNodeIDs = Array.from(deletionMap.values()).filter(Boolean);
            console.log(`🔄 NEW SYSTEM: Deleted data-node-ids:`, deletedDataNodeIDs);

            if (deletedDataNodeIDs.length > 0) {
              // Get all nodes for this book to find remaining nodes
              const db = await openDatabase();
              const nodeTx = db.transaction('nodes', 'readonly');
              const nodeStore = nodeTx.objectStore('nodes');
              const allNodes = await new Promise((resolve, reject) => {
                const req = nodeStore.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
              });

              // Filter to nodes with data-node-ids (not deleted)
              const remainingNodes = allNodes.filter(node => node.node_id && !deletedDataNodeIDs.includes(node.node_id));

              // Find nodes that might have been affected by the deleted nodes
              // (nodes that share highlights/hypercites with deleted nodes)
              const affectedDataNodeIDs = new Set();

              // Query hyperlights to find which nodes are affected
              const lightTx = db.transaction('hyperlights', 'readonly');
              const lightStore = lightTx.objectStore('hyperlights');
              const allLights = await new Promise((resolve, reject) => {
                const req = lightStore.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
              });

              allLights.forEach(light => {
                if (light._deleted_nodes && light._deleted_nodes.some(dataNodeID => deletedDataNodeIDs.includes(dataNodeID))) {
                  // This highlight was affected - rebuild its remaining nodes
                  light.node_id.forEach(dataNodeID => {
                    if (!deletedDataNodeIDs.includes(dataNodeID)) {
                      affectedDataNodeIDs.add(dataNodeID);
                    }
                  });
                }
              });

              // Query hypercites similarly
              const citeTx = db.transaction('hypercites', 'readonly');
              const citeStore = citeTx.objectStore('hypercites');
              const allCites = await new Promise((resolve, reject) => {
                const req = citeStore.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
              });

              allCites.forEach(cite => {
                if (cite._deleted_nodes && cite._deleted_nodes.some(dataNodeID => deletedDataNodeIDs.includes(dataNodeID))) {
                  // This hypercite was affected - rebuild its remaining nodes
                  cite.node_id.forEach(dataNodeID => {
                    if (!deletedDataNodeIDs.includes(dataNodeID)) {
                      affectedDataNodeIDs.add(dataNodeID);
                    }
                  });
                }
              });

              if (affectedDataNodeIDs.size > 0) {
                console.log(`🔄 NEW SYSTEM: Rebuilding arrays for ${affectedDataNodeIDs.size} affected nodes`);
                const affectedNodes = await getNodesByDataNodeIDs([...affectedDataNodeIDs]);
                await rebuildNodeArrays(affectedNodes);
                console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${affectedNodes.length} nodes after deletion`);
              } else {
                console.log(`ℹ️ NEW SYSTEM: No remaining nodes to rebuild (single-node deletions)`);
              }
            }
          } catch (hydrationError) {
            console.error('❌ NEW SYSTEM: Error rebuilding arrays after deletion:', hydrationError);
            // Don't fail the whole operation if hydration fails
          }

          resolve();
        };
        tx.onerror = (e) => reject(e.target.error);
        tx.onabort = (e) => reject(new Error("Batch deletion transaction aborted"));
      });
    } catch (error) {
      console.error("❌ Error in batchDeleteIndexedDBRecords:", error);
      throw error;
    }
  });
}

// Note: batchUpdateMigratedNodes was removed - footnote migration is now handled
// server-side in DatabaseToIndexedDBController.php
