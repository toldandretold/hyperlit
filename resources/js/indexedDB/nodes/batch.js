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

      if (existingRecord) {
        // Update existing record with new positions
        existingRecord.startChar = hyperlight.charStart;
        existingRecord.endChar = hyperlight.charEnd;
        existingRecord.startLine = numericNodeId;
        existingRecord.highlightedText = highlightedText;
        existingRecord.highlightedHTML = highlightedHTML;

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
          annotation: ""
        };

        store.put(newRecord);
        syncArray.push(newRecord);

        console.log(`Created new hyperlight ${hyperlight.highlightID} with positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
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

      if (existingRecord) {
        // Update existing record with new positions
        existingRecord.startChar = hypercite.charStart;
        existingRecord.endChar = hypercite.charEnd;
        existingRecord.hypercitedText = hypercitedText;
        existingRecord.hypercitedHTML = hypercitedHTML;

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
          time_since: hypercite.time_since || Math.floor(Date.now() / 1000)
        };

        store.put(newRecord);
        syncArray.push(newRecord);

        console.log(`Created new hypercite ${hypercite.hyperciteId} with positions: ${hypercite.charStart}-${hypercite.charEnd}`);
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
export async function batchDeleteIndexedDBRecords(nodeIds) {
  return withPending(async () => {
    // ✅ FIX: Get book ID from DOM instead of stale global variable
    const mainContent = document.querySelector('.main-content');
    const bookId = mainContent?.id || book || "latest";

    console.log(`🗑️ Batch deleting ${nodeIds.length} IndexedDB records`);
    console.log(`🔍 First 10 IDs:`, nodeIds.slice(0, 10));

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

              try {
                const lightIndex = lightsStore.index("book_startLine");
                const lightRange = IDBKeyRange.only([bookId, numericNodeId]);
                const lightReq = lightIndex.openCursor(lightRange);

                lightReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    deletedData.hyperlights.push(cursor.value); // Record for undo
                    cursor.delete();
                    cursor.continue();
                  }
                };
              } catch (lightError) {
                console.warn(`⚠️ Error deleting hyperlights for ${nodeId}:`, lightError);
              }

              try {
                const citeIndex = citesStore.index("book_startLine");
                const citeRange = IDBKeyRange.only([bookId, numericNodeId]);
                const citeReq = citeIndex.openCursor(citeRange);

                citeReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    deletedData.hypercites.push(cursor.value); // Record for undo
                    cursor.delete();
                    cursor.continue();
                  }
                };
              } catch (citeError) {
                console.warn(`⚠️ Error deleting hypercites for ${nodeId}:`, citeError);
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

          // The `queueForSync` calls inside `deleteIndexedDBRecord` are for syncing to PostgreSQL,
          // not for history. They should remain for *single* deletions. For batch deletions,
          // the debouncedMasterSync will gather all the queued items.
          // Your existing queueForSync calls for deletedData are correct for PostgreSQL sync.
          deletedData.nodes.forEach((record) => {
            queueForSync("nodes", record.startLine, "delete", record);
          });
          deletedData.hyperlights.forEach((record) => {
            queueForSync("hyperlights", record.hyperlight_id, "delete", record);
          });
          deletedData.hypercites.forEach((record) => {
            queueForSync("hypercites", record.hyperciteId, "delete", record);
          });

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
