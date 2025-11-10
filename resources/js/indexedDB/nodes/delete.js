/**
 * Node Delete Operations Module
 * Handles deletion of individual node records with all associations
 */

import { openDatabase } from '../core/connection.js';
import { parseNodeId } from '../core/utilities.js';

// Dependencies
let withPending, book, updateBookTimestamp, queueForSync;

// Initialization function to inject dependencies
export function initNodeDeleteDependencies(deps) {
  withPending = deps.withPending;
  book = deps.book;
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
}

/**
 * Delete a single IndexedDB record and all its associations
 * Deletes the node chunk plus all associated hyperlights and hypercites
 *
 * @param {string|number} id - Node ID to delete
 * @returns {Promise<boolean>} Success status
 */
export async function deleteIndexedDBRecord(id) {
  return withPending(async () => {
    // Only process numeric IDs
    if (!id || !/^\d+(\.\d+)?$/.test(id)) {
      console.log(`Skipping deletion for non-numeric ID: ${id}`);
      return false;
    }

    // ✅ FIX: Get book ID from DOM instead of stale global variable
    const mainContent = document.querySelector('.main-content');
    const bookId = mainContent?.id || book || "latest";
    const numericId = parseNodeId(id);
    console.log(
      `Deleting node with ID ${id} (numeric: ${numericId}) and its associations`
    );

    const db = await openDatabase();
    // ✅ CHANGE 1: The transaction now includes all relevant stores.
    const tx = db.transaction(
      ["nodeChunks", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore = tx.objectStore("nodeChunks");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");
    const key = [bookId, numericId];

    // Collect all records to be deleted for the history log
    const deletedHistoryPayload = {
        nodeChunks: [],
        hyperlights: [],
        hypercites: []
    };

    return new Promise((resolve, reject) => {
      const getRequest = chunksStore.get(key);

      getRequest.onsuccess = () => {
        const recordToDelete = getRequest.result;

        if (recordToDelete) {
          console.log("Found record to delete:", recordToDelete);

          deletedHistoryPayload.nodeChunks.push(recordToDelete); // Add for history

          // Now, delete the main record
          chunksStore.delete(key);

          try {
            const range = IDBKeyRange.only([bookId, numericId]);

            // Delete associated hyperlights
            const lightIndex = lightsStore.index("book_startLine");
            const lightReq = lightIndex.openCursor(range);
            lightReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                console.log("Deleting associated hyperlight:", cursor.value);
                deletedHistoryPayload.hyperlights.push(cursor.value); // Add for history
                cursor.delete();
                cursor.continue();
              }
            };

            // Delete associated hypercites
            const citeIndex = citesStore.index("book_startLine");
            const citeReq = citeIndex.openCursor(range);
            citeReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                console.log("Deleting associated hypercite:", cursor.value);
                deletedHistoryPayload.hypercites.push(cursor.value); // Add for history
                cursor.delete();
                cursor.continue();
              }
            };
          } catch (error) {
            console.warn(`⚠️ Error finding associated records for node ${numericId}:`, error);
          }
        } else {
          console.log(`No record found for key: ${key}, nothing to delete.`);
        }
      };

      getRequest.onerror = (e) => reject(e.target.error);

      tx.oncomplete = async () => {
        await updateBookTimestamp(bookId);

        // Now, queue for sync to PostgreSQL
        deletedHistoryPayload.nodeChunks.forEach((record) => {
          queueForSync("nodeChunks", record.startLine, "delete", record);
        });
        deletedHistoryPayload.hyperlights.forEach((record) => {
          queueForSync("hyperlights", record.hyperlight_id, "delete", record);
        });
        deletedHistoryPayload.hypercites.forEach((record) => {
          queueForSync("hypercites", record.hyperciteId, "delete", record);
        });

        // ✅ Dynamically import toolbar (only exists when editing)
        try {
          const { getEditToolbar } = await import('../../editToolbar/index.js');
          const toolbar = getEditToolbar();
          if (toolbar) {
              await toolbar.updateHistoryButtonStates();
          }
        } catch (e) {
          // Toolbar not loaded (not in edit mode)
        }

        resolve(true);
      };

      tx.onerror = (e) => reject(e.target.error);
    });
  });
}
