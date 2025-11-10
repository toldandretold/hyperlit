/**
 * Node Normalization Operations Module
 * Handles renumbering/normalizing node IDs in IndexedDB
 */

import { openDatabase } from '../core/connection.js';
import { parseNodeId } from '../core/utilities.js';
import { getNodeChunkFromIndexedDB } from './read.js';

// Dependencies
let withPending, book, updateBookTimestamp, queueForSync;

// Initialization function to inject dependencies
export function initNodeNormalizeDependencies(deps) {
  withPending = deps.withPending;
  book = deps.book;
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
}

/**
 * Update a node's primary key by creating new record and deleting old one
 * Used for normalization tasks (renumbering fractional/non-sequential IDs)
 *
 * @param {string|number} oldId - Original startLine of the record
 * @param {string|number} newId - New startLine for the record
 * @param {string} html - New HTML content for the record
 * @returns {Promise<boolean>} Success status
 */
export async function updateIndexedDBRecordForNormalization(
  oldId, newId, html
) {
  return withPending(async () => {
    console.log(`Normalizing record in IndexedDB: ${oldId} -> ${newId}`);

    // Only numeric IDs allowed
    const numericOldId = parseNodeId(oldId);
    const numericNewId = parseNodeId(newId);
    // ✅ FIX: Get book ID from DOM instead of stale global variable
    const mainContent = document.querySelector('.main-content');
    const bookId = mainContent?.id || book || "latest";

    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");

    // Optional timeout/abort
    const TRANSACTION_TIMEOUT = 15_000;
    const timeoutId = setTimeout(() => tx.abort(), TRANSACTION_TIMEOUT);

    // Kick off the get/put/delete sequence
    const oldKey = [bookId, numericOldId];
    const getOld = store.get(oldKey);

    getOld.onsuccess = () => {
      const oldRecord = getOld.result;
      if (oldRecord) console.log("Found old record:", oldRecord);

      // Build new record
      const newRecord = oldRecord
        ? { ...oldRecord,
            book: bookId,
            startLine: numericNewId,
            content: html || oldRecord.content }
        : { book: bookId,
            startLine: numericNewId,
            chunk_id: 0,
            content: html,
            hyperlights: [],
            hypercites: [] };

      const newKey = [bookId, numericNewId];
      const putReq = store.put(newRecord);

      putReq.onerror = (e) => {
        console.error("Error adding new record:", e.target.error);
        // Let the tx.onerror handler reject
      };

      // If we had an old record, delete it
      if (oldRecord) {
        const delReq = store.delete(oldKey);
        delReq.onerror = (e) => {
          console.error("Error deleting old record:", e.target.error);
        };
      }
    };

    getOld.onerror = (e) => {
      console.error("Error getting old record:", e.target.error);
      // Let the tx.onerror handler reject
    };

    // Now wait for the transaction to finish
    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        clearTimeout(timeoutId);
        await updateBookTimestamp(bookId);
        // Queue the deletion of the old and update of the new
        const newRecord = await getNodeChunkFromIndexedDB(bookId, newId);
        if (newRecord) {
          queueForSync("nodeChunks", newId, "update", newRecord);
        }
        queueForSync("nodeChunks", oldId, "delete");
        resolve(true);
      };
      tx.onerror = (e) => {
        clearTimeout(timeoutId);
        console.error("Transaction error during normalization:", e.target.error);
        reject(e.target.error);
      };
      tx.onabort = (e) => {
        clearTimeout(timeoutId);
        console.warn("Transaction aborted:", e);
        reject(new Error("Transaction aborted"));
      };
    });
  });
}
