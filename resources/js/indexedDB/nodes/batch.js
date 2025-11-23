/**
 * Node Batch Operations Module
 * Handles bulk updates and deletes of node chunks with highlights and hypercites
 */

import { openDatabase } from '../core/connection.js';
import { parseNodeId } from '../core/utilities.js';

// Import from the main indexedDB file (temporary until fully refactored)
let withPending, book, updateBookTimestamp, queueForSync;

// Initialization function to inject dependencies
export function initNodeBatchDependencies(deps) {
  withPending = deps.withPending;
  book = deps.book;
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
}

/**
 * Helper function to determine chunk_id from the DOM
 */
function determineChunkIdFromDOM(nodeId) {
  const node = document.getElementById(nodeId);
  if (node) {
    const chunkIdAttr = node.getAttribute('data-chunk-id');
    if (chunkIdAttr) {
      return parseInt(chunkIdAttr);
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

  // 🧹 ALSO REMOVE styled spans before saving (prevents them from being stored)
  const clonedSpans = contentClone.querySelectorAll('span[style]');
  while (clonedSpans.length > 0) {
    const span = clonedSpans[0];
    // Move all child nodes before the span, preserving HTML structure (including <br>)
    while (span.firstChild) {
      span.parentNode.insertBefore(span.firstChild, span);
    }
    // Remove the now-empty span
    span.parentNode.removeChild(span);
  }

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

  const result = {
    content: contentClone.outerHTML,
    hyperlights,
    hypercites,
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

      // ✅ NEW: Extract node_id (UUID) from DOM for new schema
      const nodeUUID = node.getAttribute('data-node-id');

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

          existingRecord._deleted_nodes.forEach(deletedUUID => {
            // Remove from node_id array
            if (existingRecord.node_id && Array.isArray(existingRecord.node_id)) {
              const beforeLength = existingRecord.node_id.length;
              existingRecord.node_id = existingRecord.node_id.filter(id => id !== deletedUUID);
              if (existingRecord.node_id.length < beforeLength) {
                console.log(`  🗑️ Removed ${deletedUUID} from node_id array`);
              }
            }

            // Remove from charData object
            if (existingRecord.charData && existingRecord.charData[deletedUUID]) {
              delete existingRecord.charData[deletedUUID];
              console.log(`  🗑️ Removed ${deletedUUID} from charData`);
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
        if (nodeUUID) {
          // Initialize if needed
          if (!existingRecord.node_id || !Array.isArray(existingRecord.node_id)) {
            existingRecord.node_id = [];
          }
          if (!existingRecord.charData || typeof existingRecord.charData !== 'object') {
            existingRecord.charData = {};
          }

          // Add this node to node_id array if not present
          if (!existingRecord.node_id.includes(nodeUUID)) {
            existingRecord.node_id.push(nodeUUID);
            console.log(`➕ Added node ${nodeUUID} to highlight ${hyperlight.highlightID}`);
          }

          // Update charData for this specific node
          existingRecord.charData[nodeUUID] = {
            charStart: hyperlight.charStart,
            charEnd: hyperlight.charEnd
          };

          console.log(`✅ Updated NEW schema for ${hyperlight.highlightID}: node_id=${existingRecord.node_id.length} nodes, charData updated for ${nodeUUID}`);
        }

        store.put(existingRecord);
        syncArray.push(existingRecord);

        console.log(`Updated hyperlight ${hyperlight.highlightID} positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
      } else {
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
          node_id: nodeUUID ? [nodeUUID] : [],
          charData: nodeUUID ? {
            [nodeUUID]: {
              charStart: hyperlight.charStart,
              charEnd: hyperlight.charEnd
            }
          } : {}
        };

        store.put(newRecord);
        syncArray.push(newRecord);

        console.log(`Created new hyperlight ${hyperlight.highlightID} with positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
        if (nodeUUID) {
          console.log(`✅ Initialized NEW schema: node_id=[${nodeUUID}], charData set`);
        }
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

      // ✅ NEW: Extract node_id (UUID) from DOM for new schema
      const nodeUUID = node.getAttribute('data-node-id');

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

          existingRecord._deleted_nodes.forEach(deletedUUID => {
            // Remove from node_id array
            if (existingRecord.node_id && Array.isArray(existingRecord.node_id)) {
              const beforeLength = existingRecord.node_id.length;
              existingRecord.node_id = existingRecord.node_id.filter(id => id !== deletedUUID);
              if (existingRecord.node_id.length < beforeLength) {
                console.log(`  🗑️ Removed ${deletedUUID} from node_id array`);
              }
            }

            // Remove from charData object
            if (existingRecord.charData && existingRecord.charData[deletedUUID]) {
              delete existingRecord.charData[deletedUUID];
              console.log(`  🗑️ Removed ${deletedUUID} from charData`);
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
        if (nodeUUID) {
          // Initialize if needed
          if (!existingRecord.node_id || !Array.isArray(existingRecord.node_id)) {
            existingRecord.node_id = [];
          }
          if (!existingRecord.charData || typeof existingRecord.charData !== 'object') {
            existingRecord.charData = {};
          }

          // Add this node to node_id array if not present
          if (!existingRecord.node_id.includes(nodeUUID)) {
            existingRecord.node_id.push(nodeUUID);
            console.log(`➕ Added node ${nodeUUID} to hypercite ${hypercite.hyperciteId}`);
          }

          // Update charData for this specific node
          existingRecord.charData[nodeUUID] = {
            charStart: hypercite.charStart,
            charEnd: hypercite.charEnd
          };

          console.log(`✅ Updated NEW schema for ${hypercite.hyperciteId}: node_id=${existingRecord.node_id.length} nodes, charData updated for ${nodeUUID}`);
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
          node_id: nodeUUID ? [nodeUUID] : [],
          charData: nodeUUID ? {
            [nodeUUID]: {
              charStart: hypercite.charStart,
              charEnd: hypercite.charEnd
            }
          } : {}
        };

        store.put(newRecord);
        syncArray.push(newRecord);

        console.log(`Created new hypercite ${hypercite.hyperciteId} with positions: ${hypercite.charStart}-${hypercite.charEnd}`);
        if (nodeUUID) {
          console.log(`✅ Initialized NEW schema: node_id=[${nodeUUID}], charData set`);
        }
      }
    };
  });
}

/**
 * Update a single IndexedDB record from DOM changes
 * This is a CORE operation - used in read mode for highlights and hypercites
 *
 * @param {Object} record - Record object with id and html
 * @returns {Promise<void>}
 */
export function updateIndexedDBRecord(record) {
  return withPending(async () => {
    // ✅ FIX: Get book ID from DOM instead of stale global variable
    const mainContent = document.querySelector('.main-content');
    const bookId = mainContent?.id || book || "latest";

    // Find the nearest ancestor with a numeric ID
    let nodeId = record.id;
    let node = document.getElementById(nodeId);
    while (node && !/^\d+(\.\d+)?$/.test(nodeId)) {
      node = node.parentElement;
      if (node?.id) nodeId = node.id;
    }

    if (!/^\d+(\.\d+)?$/.test(nodeId)) {
      console.log(
        `Skipping IndexedDB update – no valid parent node ID for ${record.id}`
      );
      return;
    }

    const numericNodeId = parseNodeId(nodeId);

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodes", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore = tx.objectStore("nodes");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");
    const compositeKey = [bookId, numericNodeId];

    // Arrays to collect what we actually save for sync
    let savedNodeChunk = null;
    const savedHyperlights = [];
    const savedHypercites = [];

    // 🔥 USE YOUR EXISTING FUNCTION TO PROPERLY PROCESS THE NODE
    const processedData = node ? processNodeContentHighlightsAndCites(node) : null;

    // ✅ EXTRACT node_id from data-node-id attribute
    const nodeIdFromDOM = node ? node.getAttribute('data-node-id') : null;

    // Fetch the existing chunk record
    const getReq = chunksStore.get(compositeKey);

    getReq.onsuccess = () => {
      const existing = getReq.result;
      let toSave;

      if (existing) {
        console.log("Existing nodeChunk found for merge:", JSON.stringify(existing));

        // Start with a copy of the existing record to preserve its structure
        toSave = { ...existing };

        // 🔥 USE PROCESSED CONTENT (WITHOUT MARK/U TAGS)
        if (processedData) {
          toSave.content = processedData.content;
          // Update hyperlights and hypercites arrays in the node chunk
          toSave.hyperlights = processedData.hyperlights;
          toSave.hypercites = processedData.hypercites;
        } else {
          // Fallback to record.html if no DOM node available
          toSave.content = record.html;
        }

        // ✅ FIX: Determine chunk_id from DOM if not provided
        if (record.chunk_id !== undefined) {
          toSave.chunk_id = record.chunk_id;
          console.log(`Updated chunk_id to ${record.chunk_id} for node ${nodeId}`);
        } else {
          toSave.chunk_id = determineChunkIdFromDOM(nodeId);
        }

        // ✅ UPDATE node_id from DOM if available
        if (nodeIdFromDOM) {
          toSave.node_id = nodeIdFromDOM;
          console.log(`Updated node_id to ${nodeIdFromDOM} for node ${nodeId}`);
        }

      } else {
        // Case: No existing record, create a new one
        console.log("No existing nodeChunk record, creating new one.");
        toSave = {
          book: bookId,
          startLine: numericNodeId,
          chunk_id: record.chunk_id !== undefined ? record.chunk_id : determineChunkIdFromDOM(nodeId),
          node_id: nodeIdFromDOM || null,
          content: processedData ? processedData.content : record.html,
          hyperlights: processedData ? processedData.hyperlights : [],
          hypercites: processedData ? processedData.hypercites : []
        };
        console.log("New nodeChunk record to create:", JSON.stringify(toSave));
      }

      console.log("Final nodeChunk record to put:", JSON.stringify(toSave));

      // Store for sync
      savedNodeChunk = toSave;

      // write the node chunk
      chunksStore.put(toSave);

      // 🔥 UPDATE INDIVIDUAL HYPERLIGHT/HYPERCITE RECORDS USING PROCESSED DATA
      if (processedData) {
        updateHyperlightRecords(processedData.hyperlights, lightsStore, bookId, numericNodeId, savedHyperlights, node);
        updateHyperciteRecords(processedData.hypercites, citesStore, bookId, savedHypercites, node);
      }
    };

    getReq.onerror = (e) => {
      console.error("Error fetching nodeChunk for update:", e.target.error);
    };

    // return a promise that resolves/rejects with the transaction
    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ IndexedDB record update complete");
        await updateBookTimestamp(bookId);

        // MODIFIED: Pass the full data object to the queue.
        if (savedNodeChunk) {
          queueForSync(
            "nodes",
            savedNodeChunk.startLine,
            "update",
            savedNodeChunk
          );
        }
        savedHyperlights.forEach((hl) => {
          queueForSync("hyperlights", hl.hyperlight_id, "update", hl);
        });
        savedHypercites.forEach((hc) => {
          queueForSync("hypercites", hc.hyperciteId, "update", hc);
        });

        resolve();
      };
      tx.onerror = (e) => reject(e.target.error);
      tx.onabort = (e) => reject(new Error("Transaction aborted"));
    });
  });
}

/**
 * Batch update multiple IndexedDB records
 * More efficient than calling updateIndexedDBRecord multiple times
 *
 * @param {Array} recordsToProcess - Array of record objects
 * @returns {Promise<void>}
 */
export async function batchUpdateIndexedDBRecords(recordsToProcess) {
  return withPending(async () => {
    // ✅ FIX: Get book ID from DOM instead of stale global variable
    // During new book creation, global variable may not be updated yet
    const mainContent = document.querySelector('.main-content');
    const bookId = mainContent?.id || book || "latest";
    console.log(
      `🔄 Batch updating ${recordsToProcess.length} IndexedDB records`,
    );

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodes", "hyperlights", "hypercites"],
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

      let nodeId = record.id;
      let node = document.getElementById(nodeId);
      while (node && !/^\d+(\.\d+)?$/.test(nodeId)) {
        node = node.parentElement;
        if (node?.id) nodeId = node.id;
      }

      if (!/^\d+(\.\d+)?$/.test(nodeId)) {
        console.log(
          `Skipping batch update – no valid parent for ${record.id}`,
        );
        return;
      }

      const finalNumericNodeId = parseNodeId(nodeId); // Use the final valid ID
      const existing = originalNodeChunkStates.get(finalNumericNodeId);
      const existingHypercites = existing?.hypercites || [];
      const processedData = node
        ? processNodeContentHighlightsAndCites(node, existingHypercites)
        : null;

      // ✅ EXTRACT node_id from data-node-id attribute
      const nodeIdFromDOM = node ? node.getAttribute('data-node-id') : null;

      // 🔍 DEBUG: Log node_id extraction
      console.log(`[node_id DEBUG] record.id=${record.id}, finalNodeId=${nodeId}, node=${node?.tagName}, nodeIdFromDOM=${nodeIdFromDOM}`);
      if (node && !nodeIdFromDOM) {
        console.warn(`⚠️ Node found but no data-node-id attribute! Element:`, node.outerHTML.substring(0, 200));
      }

      let toSave;
      if (existing) {
        toSave = { ...existing };
        if (processedData) {
          toSave.content = processedData.content;
          toSave.hyperlights = processedData.hyperlights;
          toSave.hypercites = processedData.hypercites;
        } else {
          toSave.content = record.html || existing.content;
        }
        // ✅ FIX: Determine chunk_id from DOM if not provided
        if (record.chunk_id !== undefined) {
          toSave.chunk_id = record.chunk_id;
        } else {
          toSave.chunk_id = determineChunkIdFromDOM(nodeId);
        }
        // ✅ UPDATE node_id from DOM if available
        if (nodeIdFromDOM) {
          toSave.node_id = nodeIdFromDOM;
        }
      } else {
        toSave = {
          book: bookId,
          startLine: finalNumericNodeId,
          chunk_id: record.chunk_id !== undefined ? record.chunk_id : determineChunkIdFromDOM(nodeId),
          node_id: nodeIdFromDOM || null,
          content: processedData ? processedData.content : record.html || "",
          hyperlights: processedData ? processedData.hyperlights : [],
          hypercites: processedData ? processedData.hypercites : [],
        };
      }

      // 🔍 DEBUG: Log what's being saved
      console.log(`[node_id DEBUG] Saving to IndexedDB:`, { startLine: toSave.startLine, node_id: toSave.node_id, hasContent: !!toSave.content });

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
        await updateBookTimestamp(book || "latest");

        allSavedNodeChunks.forEach((chunk) => {
          const originalChunk = originalNodeChunkStates.get(chunk.startLine);
          queueForSync(
            "nodes",
            chunk.startLine,
            "update",
            chunk,
            originalChunk,
          );
        });
        allSavedHyperlights.forEach((hl) => {
          queueForSync("hyperlights", hl.hyperlight_id, "update", hl, null);
        });
        allSavedHypercites.forEach((hc) => {
          queueForSync("hypercites", hc.hyperciteId, "update", hc, null);
        });

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
 * @param {Array} nodeIds - Array of node IDs to delete
 * @returns {Promise<void>}
 */
export async function batchDeleteIndexedDBRecords(nodeIds, deletionMap = new Map()) {
  return withPending(async () => {
    // ✅ FIX: Get book ID from DOM instead of stale global variable
    const mainContent = document.querySelector('.main-content');
    const bookId = mainContent?.id || book || "latest";

    console.log(`🗑️ Batch deleting ${nodeIds.length} IndexedDB records`);
    console.log(`🔍 First 10 IDs:`, nodeIds.slice(0, 10));
    console.log(`🔍 Deletion map has ${deletionMap.size} UUIDs`);

    try {
      const db = await openDatabase();
      console.log(`✅ Database opened successfully`);

      const tx = db.transaction(
        ["nodes", "hyperlights", "hypercites"],
        "readwrite"
      );
      console.log(`✅ Transaction created`);

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

      // Process each node ID for deletion
      const deletePromises = nodeIds.map(async (nodeId, index) => {
        console.log(`🔍 Processing deletion ${index + 1}/${nodeIds.length}: ${nodeId}`);

        if (!/^\d+(\.\d+)?$/.test(nodeId)) {
          console.log(`❌ Skipping deletion – invalid node ID: ${nodeId}`);
          return;
        }

        const numericNodeId = parseNodeId(nodeId);
        const compositeKey = [bookId, numericNodeId];

        return new Promise((resolve, reject) => {
          const getReq = chunksStore.get(compositeKey);

          getReq.onsuccess = () => {
            const existing = getReq.result;

            if (existing) {
              console.log(`✅ Found existing record for ${nodeId}, deleting...`);

              // ✅ CHANGE 1: Store the original record for the history log.
              // We no longer need the `_deleted: true` flag.
              deletedData.nodes.push(existing); // This is the record to ADD BACK on UNDO

              const deleteReq = chunksStore.delete(compositeKey);
              deleteReq.onsuccess = () => {
                processedCount++;
                console.log(`✅ Deleted ${nodeId} (${processedCount}/${nodeIds.length})`);
                resolve();
              };
              deleteReq.onerror = (e) => reject(e.target.error);

              // ✅ NEW: Get node UUID from deletionMap (captured before DOM removal)
              // Define OUTSIDE try blocks so both hyperlight and hypercite code can access it
              const deletedNodeUUID = deletionMap.get(nodeId);
              console.log(`🗑️ Batch deleting node ${numericNodeId}, UUID: ${deletedNodeUUID}`);

              try {
                // ✅ NEW: Update hyperlights - mark deleted node instead of deleting the record
                const bookIndex = lightsStore.index("book");
                const bookRange = IDBKeyRange.only(bookId);
                const lightReq = bookIndex.openCursor(bookRange);

                lightReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    const highlight = cursor.value;

                    // Check if this highlight affects the deleted node
                    const affectsDeletedNode =
                      highlight.startLine === numericNodeId || // OLD schema check
                      (highlight.node_id && Array.isArray(highlight.node_id) &&
                       deletedNodeUUID && highlight.node_id.includes(deletedNodeUUID)); // NEW schema check

                    if (affectsDeletedNode) {
                      console.log(`📍 Found highlight ${highlight.hyperlight_id} affecting deleted node ${numericNodeId}`);

                      // Check if multi-node highlight
                      if (highlight.node_id && highlight.node_id.length > 1) {
                        // Multi-node highlight - mark node for deletion cleanup
                        console.log(`🔧 Multi-node highlight detected (${highlight.node_id.length} nodes) - marking node ${deletedNodeUUID} for cleanup`);

                        // ✅ Track deleted node for cleanup during next save
                        if (!highlight._deleted_nodes) {
                          highlight._deleted_nodes = [];
                        }
                        if (deletedNodeUUID && !highlight._deleted_nodes.includes(deletedNodeUUID)) {
                          highlight._deleted_nodes.push(deletedNodeUUID);
                          console.log(`📌 Marked node ${deletedNodeUUID} for deletion from highlight ${highlight.hyperlight_id}`);
                        }

                        // Save updated highlight (don't delete it!)
                        cursor.update(highlight);
                        console.log(`✅ Marked highlight ${highlight.hyperlight_id} for cleanup (still ${highlight.node_id.length} nodes until cleanup)`);
                      } else {
                        // Single-node highlight - OLD SYSTEM behavior (delete from OLD schema stores)
                        if (highlight.startLine === numericNodeId) {
                          console.log(`🗑️ Single-node highlight ${highlight.hyperlight_id} - deleting via OLD system`);
                          deletedData.hyperlights.push(cursor.value); // Record for undo
                          cursor.delete();
                        } else {
                          // Single-node in NEW schema - mark as orphaned
                          console.log(`⏳ Single-node highlight ${highlight.hyperlight_id} - marking as orphaned (will cleanup if not found in DOM)`);
                          highlight._orphaned_at = Date.now();
                          highlight._orphaned_from_node = deletedNodeUUID || numericNodeId.toString();

                          // Track deleted node for cleanup
                          if (!highlight._deleted_nodes) {
                            highlight._deleted_nodes = [];
                          }
                          if (deletedNodeUUID && !highlight._deleted_nodes.includes(deletedNodeUUID)) {
                            highlight._deleted_nodes.push(deletedNodeUUID);
                          }

                          cursor.update(highlight);
                        }
                      }
                    }

                    cursor.continue();
                  }
                };
              } catch (lightError) {
                console.warn(`⚠️ Error updating hyperlights for ${nodeId}:`, lightError);
              }

              try {
                // ✅ NEW: Update hypercites - mark deleted node instead of deleting the record
                // (deletedElement and deletedNodeUUID already retrieved above)
                const citeIndex = citesStore.index("book");
                const citeRange = IDBKeyRange.only(bookId);
                const citeReq = citeIndex.openCursor(citeRange);

                citeReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    const hypercite = cursor.value;

                    // Check if this hypercite affects the deleted node
                    const affectsDeletedNode =
                      (hypercite.node_id && Array.isArray(hypercite.node_id) &&
                       deletedNodeUUID && hypercite.node_id.includes(deletedNodeUUID));

                    if (affectsDeletedNode) {
                      console.log(`📍 Found hypercite ${hypercite.hyperciteId} affecting deleted node ${numericNodeId}`);

                      // Check if multi-node hypercite
                      if (hypercite.node_id && hypercite.node_id.length > 1) {
                        // Multi-node hypercite - mark node for deletion cleanup
                        console.log(`🔧 Multi-node hypercite detected (${hypercite.node_id.length} nodes) - marking node ${deletedNodeUUID} for cleanup`);

                        // ✅ Track deleted node for cleanup during next save
                        if (!hypercite._deleted_nodes) {
                          hypercite._deleted_nodes = [];
                        }
                        if (deletedNodeUUID && !hypercite._deleted_nodes.includes(deletedNodeUUID)) {
                          hypercite._deleted_nodes.push(deletedNodeUUID);
                          console.log(`📌 Marked node ${deletedNodeUUID} for deletion from hypercite ${hypercite.hyperciteId}`);
                        }

                        // Save updated hypercite (don't delete it!)
                        cursor.update(hypercite);
                        console.log(`✅ Marked hypercite ${hypercite.hyperciteId} for cleanup (still ${hypercite.node_id.length} nodes until cleanup)`);
                      } else {
                        // Single-node hypercite - mark as orphaned
                        console.log(`⏳ Single-node hypercite ${hypercite.hyperciteId} - marking as orphaned (will cleanup if not found in DOM)`);
                        hypercite._orphaned_at = Date.now();
                        hypercite._orphaned_from_node = deletedNodeUUID || numericNodeId.toString();

                        // Track deleted node for cleanup
                        if (!hypercite._deleted_nodes) {
                          hypercite._deleted_nodes = [];
                        }
                        if (deletedNodeUUID && !hypercite._deleted_nodes.includes(deletedNodeUUID)) {
                          hypercite._deleted_nodes.push(deletedNodeUUID);
                        }

                        cursor.update(hypercite);
                      }
                    } else if (hypercite.startLine === numericNodeId) {
                      // OLD SYSTEM - hypercite only in old schema
                      console.log(`🗑️ Old schema hypercite - deleting via OLD system`);
                      deletedData.hypercites.push(cursor.value); // Record for undo
                      cursor.delete();
                    }

                    cursor.continue();
                  }
                };
              } catch (citeError) {
                console.warn(`⚠️ Error updating hypercites for ${nodeId}:`, citeError);
              }
            } else {
              console.log(`⚠️ No existing record found for ${nodeId}`);
              resolve();
            }
          };

          getReq.onerror = (e) => reject(e.target.error);
        });
      });

      await Promise.all(deletePromises);
      console.log(`✅ All deletion promises completed`);

      return new Promise((resolve, reject) => {
        tx.oncomplete = async () => {
          console.log(`✅ Batch IndexedDB deletion transaction complete...`);
          await updateBookTimestamp(bookId);

          // Queue deleted records for PostgreSQL sync
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
            const { rebuildNodeArrays, getNodesByUUIDs } = await import('../index.js');

            // Collect all remaining node UUIDs from deletionMap that weren't deleted
            const deletedUUIDs = Array.from(deletionMap.values()).filter(Boolean);
            console.log(`🔄 NEW SYSTEM: Deleted node UUIDs:`, deletedUUIDs);

            if (deletedUUIDs.length > 0) {
              // Get all nodes for this book to find remaining nodes
              const db = await openDatabase();
              const nodeTx = db.transaction('nodes', 'readonly');
              const nodeStore = nodeTx.objectStore('nodes');
              const allNodes = await new Promise((resolve, reject) => {
                const req = nodeStore.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
              });

              // Filter to nodes with UUIDs (not deleted)
              const remainingNodes = allNodes.filter(node => node.node_id && !deletedUUIDs.includes(node.node_id));

              // Find nodes that might have been affected by the deleted nodes
              // (nodes that share highlights/hypercites with deleted nodes)
              const affectedNodeUUIDs = new Set();

              // Query hyperlights to find which nodes are affected
              const lightTx = db.transaction('hyperlights', 'readonly');
              const lightStore = lightTx.objectStore('hyperlights');
              const allLights = await new Promise((resolve, reject) => {
                const req = lightStore.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
              });

              allLights.forEach(light => {
                if (light._deleted_nodes && light._deleted_nodes.some(uuid => deletedUUIDs.includes(uuid))) {
                  // This highlight was affected - rebuild its remaining nodes
                  light.node_id.forEach(uuid => {
                    if (!deletedUUIDs.includes(uuid)) {
                      affectedNodeUUIDs.add(uuid);
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
                if (cite._deleted_nodes && cite._deleted_nodes.some(uuid => deletedUUIDs.includes(uuid))) {
                  // This hypercite was affected - rebuild its remaining nodes
                  cite.node_id.forEach(uuid => {
                    if (!deletedUUIDs.includes(uuid)) {
                      affectedNodeUUIDs.add(uuid);
                    }
                  });
                }
              });

              if (affectedNodeUUIDs.size > 0) {
                console.log(`🔄 NEW SYSTEM: Rebuilding arrays for ${affectedNodeUUIDs.size} affected nodes`);
                const affectedNodes = await getNodesByUUIDs([...affectedNodeUUIDs]);
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
