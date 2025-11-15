/**
 * Hypercites Operations Module
 * Handles hypercite (two-way citation) operations in IndexedDB
 */

import { parseNodeId } from '../core/utilities.js';
import { resolveHypercite } from './helpers.js';

// Import from the main indexedDB file (temporary until fully refactored)
let updateBookTimestamp, queueForSync, withPending;

// Dependencies needed from other modules
let getNodeChunksFromIndexedDB;

// Initialization function to inject dependencies
export function initHypercitesDependencies(deps) {
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
  withPending = deps.withPending;
  getNodeChunksFromIndexedDB = deps.getNodeChunksFromIndexedDB;
}

/**
 * Get a hypercite from IndexedDB
 *
 * @param {string} book - Book identifier
 * @param {string} hyperciteId - Hypercite identifier
 * @returns {Promise<Object|null>} Hypercite record or null
 */
export async function getHyperciteFromIndexedDB(book, hyperciteId) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "hypercites";

    const request = indexedDB.open(dbName);

    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      resolve(null);
    };

    request.onsuccess = (event) => {
      const db = event.target.result;

      try {
        const transaction = db.transaction([storeName], "readonly");
        const objectStore = transaction.objectStore(storeName);

        // Create the composite key [book, hyperciteId]
        const key = [book, hyperciteId];

        // Get the record using the composite key
        const getRequest = objectStore.get(key);

        getRequest.onsuccess = (event) => {
          const record = event.target.result;
          resolve(record);
        };

        getRequest.onerror = (event) => {
          console.error(`Error getting hypercite record:`, event.target.error);
          resolve(null);
        };

        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("Transaction error:", error);
        resolve(null);
      }
    };
  });
}

/**
 * Update a hypercite in IndexedDB
 * This is a CORE operation - used in read mode for citation linking
 *
 * @param {string} book - Book identifier
 * @param {string} hyperciteId - Hypercite identifier
 * @param {Object} updatedFields - Fields to update
 * @param {boolean} skipQueue - Skip sync queue (for batched operations)
 * @returns {Promise<boolean>} Success status
 */
export async function updateHyperciteInIndexedDB(book, hyperciteId, updatedFields, skipQueue = false) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "hypercites";

    console.log(`Updating in hypercites store: ${dbName}, key: [${book}, ${hyperciteId}], skipQueue: ${skipQueue}`);

    const request = indexedDB.open(dbName);

    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      resolve(false);
    };

    request.onsuccess = (event) => {
      const db = event.target.result;

      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);

        // Create the composite key [book, hyperciteId]
        const key = [book, hyperciteId];

        // Get the record using the composite key
        const getRequest = objectStore.get(key);

        getRequest.onsuccess = (event) => {
          const existingRecord = event.target.result;

          if (!existingRecord) {
            console.error(`Hypercite record not found for key: [${book}, ${hyperciteId}]`);
            resolve(false);
            return;
          }

          console.log("Found existing hypercite record:", existingRecord);

          // Update the fields in the existing record
          Object.assign(existingRecord, updatedFields);

          // Put the updated record back
          const updateRequest = objectStore.put(existingRecord);

          updateRequest.onsuccess = async() => {
            console.log(`Successfully updated hypercite for key: [${book}, ${hyperciteId}]`);
            console.log(`🔍 Queuing hypercite with citedIN:`, existingRecord.citedIN, `status:`, existingRecord.relationshipStatus);
            await updateBookTimestamp(book);
            if (!skipQueue) {
              queueForSync("hypercites", hyperciteId, "update", existingRecord);
            } else {
              console.log(`⏭️ Skipping queue for hypercite ${hyperciteId} (batched sync)`);
            }
            resolve(true);
          };

          updateRequest.onerror = (event) => {
            console.error(`Error updating hypercite record:`, event.target.error);
            resolve(false);
          };
        };

        getRequest.onerror = (event) => {
          console.error(`Error getting hypercite record:`, event.target.error);
          resolve(false);
        };

        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("Transaction error:", error);
        resolve(false);
      }
    };
  });
}

/**
 * Add a citation to a hypercite's citedIN array
 * Updates both the nodeChunk and hypercites stores
 *
 * @param {string} book - Book identifier
 * @param {string|number} startLine - Starting line of node containing hypercite
 * @param {string} hyperciteId - Hypercite identifier
 * @param {string} newCitation - Citation URL to add
 * @returns {Promise<Object>} Result with success status and relationship status
 */
export async function addCitationToHypercite(book, startLine, hyperciteId, newCitation) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";

    const numericStartLine = parseNodeId(startLine);

    console.log(`Adding citation to hypercite in nodeChunk: book=${book}, startLine=${numericStartLine}, hyperciteId=${hyperciteId}, citation=${newCitation}`);

    const request = indexedDB.open(dbName);

    request.onsuccess = (event) => {
      const db = event.target.result;

      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);

        const key = [book, numericStartLine];
        console.log("Using key for update:", key);

        const getRequest = objectStore.get(key);

        getRequest.onsuccess = (event) => {
          const record = event.target.result;

          if (!record) {
            console.error(`Record not found for key: [${book}, ${numericStartLine}]`);
            resolve({ success: false });
            return;
          }

          console.log("Existing nodeChunk before update:", JSON.stringify(record));

          // Ensure hypercites array exists and is an array
          if (!Array.isArray(record.hypercites)) {
            record.hypercites = [];
          }

          // Find the specific hypercite to update
          const hyperciteIndex = record.hypercites.findIndex(h => h.hyperciteId === hyperciteId);

          if (hyperciteIndex === -1) {
            console.error(`Hypercite ${hyperciteId} not found in nodeChunk [${book}, ${numericStartLine}]`);
            resolve({ success: false });
            return;
          }

          // Get a reference to the existing hypercite object within the array
          const hyperciteToUpdate = record.hypercites[hyperciteIndex];

          // Ensure citedIN array exists for the hypercite being updated
          if (!Array.isArray(hyperciteToUpdate.citedIN)) {
            hyperciteToUpdate.citedIN = [];
          }

          // Add the citation if it doesn't already exist
          if (!hyperciteToUpdate.citedIN.includes(newCitation)) {
            hyperciteToUpdate.citedIN.push(newCitation);
            console.log(`Added citation ${newCitation} to hypercite ${hyperciteId}`);
          } else {
             console.log(`Citation ${newCitation} already exists for hypercite ${hyperciteId}`);
          }

          // Update relationshipStatus based on citedIN length
          hyperciteToUpdate.relationshipStatus =
            hyperciteToUpdate.citedIN.length === 1 ? "couple" :
            hyperciteToUpdate.citedIN.length >= 2 ? "poly" : "single";

          console.log("Updated hypercite object:", JSON.stringify(hyperciteToUpdate));
          console.log("NodeChunk after modifying hypercite:", JSON.stringify(record));

          // Put the *entire* updated record back
          const updateRequest = objectStore.put(record);

          updateRequest.onsuccess = async() => {
            console.log(`✅ Successfully updated nodeChunk [${book}, ${numericStartLine}]`);

            // IMMEDIATE verification within the same function
            const immediateVerify = objectStore.get(key);
            immediateVerify.onsuccess = (e) => {
              const verifyRecord = e.target.result;
              const verifyHypercite = verifyRecord?.hypercites?.find(h => h.hyperciteId === hyperciteId);
              console.log('🔍 IMMEDIATE VERIFY - hypercite after put:', verifyHypercite);
              console.log('🔍 IMMEDIATE VERIFY - citedIN:', verifyHypercite?.citedIN);
            };

            await updateBookTimestamp(book);
            resolve({
              success: true,
              relationshipStatus: hyperciteToUpdate.relationshipStatus
            });
          };

          updateRequest.onerror = (event) => {
            console.error(`❌ Error updating nodeChunk record:`, event.target.error);
            resolve({ success: false });
          };
        };

        getRequest.onerror = (event) => {
          console.error(`❌ Error getting nodeChunk record:`, event.target.error);
          resolve({ success: false });
        };
      } catch (error) {
        console.error("❌ Transaction error:", error);
        resolve({ success: false });
      }
    };

    request.onerror = (event) => {
      console.error(`❌ IndexedDB error: ${event.target.errorCode}`);
      resolve({ success: false });
    };
  });
}

/**
 * Update citation for an existing hypercite
 * This is a CORE operation - handles bidirectional citation linking in read mode
 *
 * @param {string} booka - Book containing the hypercite
 * @param {string} hyperciteIDa - Hypercite identifier
 * @param {string} citationIDb - Citation URL to add
 * @returns {Promise<Object>} Result with success, startLine, and newStatus
 */
export function updateCitationForExistingHypercite(
  booka,
  hyperciteIDa,
  citationIDb,
) {
  return withPending(async () => {
    console.log(
      `Updating citation: book=${booka}, hyperciteID=${hyperciteIDa}, citationIDb=${citationIDb}`,
    );

    // ✅ --- NEW PRE-FLIGHT CHECK ---
    // First, ensure the hypercite exists in our local IndexedDB, fetching
    // it from the server if necessary.
    // Note: resolveHypercite will be imported from a helper module
    // resolveHypercite already imported statically
    const resolvedHypercite = await resolveHypercite(booka, hyperciteIDa);

    // If it's not found anywhere (local or server), we cannot proceed.
    if (!resolvedHypercite) {
      console.error(
        `FATAL: Could not resolve hypercite ${hyperciteIDa} from any source. Aborting link.`,
      );
      return { success: false, startLine: null, newStatus: null };
    }
    // ✅ --- END OF NEW LOGIC ---

    let affectedStartLine = null;
    const nodeChunks = await getNodeChunksFromIndexedDB(booka);
    if (!nodeChunks?.length) {
      console.warn(`No nodes found in nodeChunks object store in IndexedDB for book ${booka}`);
      return { success: false, startLine: null, newStatus: null };
    }

    let foundAndUpdated = false;
    let updatedRelationshipStatus = "single";

    // 1) Update the nodeChunks store
    for (const record of nodeChunks) {
      if (!record.hypercites?.find((hc) => hc.hyperciteId === hyperciteIDa)) {
        continue;
      }
      const startLine = record.startLine;
      const result = await addCitationToHypercite(
        booka,
        startLine,
        hyperciteIDa,
        citationIDb,
      );
      if (result.success) {
        foundAndUpdated = true;
        updatedRelationshipStatus = result.relationshipStatus;
        affectedStartLine = startLine;
        break;
      }
    }

    if (!foundAndUpdated) {
      console.log(
        `No matching hypercite found in book ${booka} with ID ${hyperciteIDa}`,
      );
      return { success: false, startLine: null, newStatus: null };
    }

    // 2) Update the hypercites object store itself
    const existingHypercite = await getHyperciteFromIndexedDB(
      booka,
      hyperciteIDa,
    );

    if (existingHypercite) {
      if (!Array.isArray(existingHypercite.citedIN)) {
        existingHypercite.citedIN = [];
      }
      if (!existingHypercite.citedIN.includes(citationIDb)) {
        existingHypercite.citedIN.push(citationIDb);
      }
      existingHypercite.relationshipStatus = updatedRelationshipStatus;

      await updateHyperciteInIndexedDB(
        booka,
        hyperciteIDa,
        existingHypercite,
        false,
      );
    }

    return {
      success: true,
      startLine: affectedStartLine,
      newStatus: updatedRelationshipStatus,
    };
  });
}

// PostgreSQL Sync
export {
  syncHyperciteToPostgreSQL,
  syncHyperciteUpdateImmediately,
  syncHyperciteWithNodeChunkImmediately,
} from './syncHypercitesToPostgreSQL.js';
