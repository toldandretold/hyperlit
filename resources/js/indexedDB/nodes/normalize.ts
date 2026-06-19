/**
 * Node Normalization Operations Module
 * Handles renumbering/normalizing node IDs in IndexedDB
 */

import { openDatabase } from '../core/connection';
import { parseNodeId } from '../core/utilities';
import { getNodeChunkFromIndexedDB } from './read';
import { asBookId, type BookId, type QueueForSyncFn } from '../types';

interface NormalizeDeps {
  withPending: <T>(fn: () => Promise<T>) => Promise<T>;
  book: BookId | null | undefined;
  updateBookTimestamp: (bookId: BookId) => Promise<unknown>;
  queueForSync: QueueForSyncFn;
}

// Dependencies (crash-if-uninitialized, same as the pre-TS module)
let withPending: NormalizeDeps['withPending'];
let book: NormalizeDeps['book'];
let updateBookTimestamp: NormalizeDeps['updateBookTimestamp'];
let queueForSync: NormalizeDeps['queueForSync'];

// Initialization function to inject dependencies
export function initNodeNormalizeDependencies(deps: NormalizeDeps): void {
  withPending = deps.withPending;
  book = deps.book;
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
}

/**
 * Update a node's primary key by creating new record and deleting old one
 * Used for normalization tasks (renumbering fractional/non-sequential IDs)
 *
 * @returns Success status
 */
export async function updateIndexedDBRecordForNormalization(
  oldId: string | number,
  newId: string | number,
  html: string | null,
): Promise<boolean> {
  return withPending(async () => {
    console.log(`Normalizing record in IndexedDB: ${oldId} -> ${newId}`);

    // Only numeric IDs allowed
    const numericOldId = parseNodeId(oldId);
    const numericNewId = parseNodeId(newId);
    // ✅ FIX: Get book ID from DOM — check sub-book container first
    const mainContent = document.querySelector('.main-content');
    const element = document.getElementById(String(oldId));
    const subBookFromDom = element?.closest('[data-book-id]') as HTMLElement | null | undefined;
    const bookId = asBookId(subBookFromDom?.dataset?.bookId || mainContent?.id || book || "latest");

    const db = await openDatabase();
    const tx = db.transaction("nodes", "readwrite");
    const store = tx.objectStore("nodes");

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

      const putReq = store.put(newRecord);

      putReq.onerror = () => {
        console.error("Error adding new record:", putReq.error);
        // Let the tx.onerror handler reject
      };

      // If we had an old record, delete it
      if (oldRecord) {
        const delReq = store.delete(oldKey);
        delReq.onerror = () => {
          console.error("Error deleting old record:", delReq.error);
        };
      }
    };

    getOld.onerror = () => {
      console.error("Error getting old record:", getOld.error);
      // Let the tx.onerror handler reject
    };

    // Now wait for the transaction to finish
    return new Promise<boolean>((resolve, reject) => {
      tx.oncomplete = async () => {
        clearTimeout(timeoutId);
        await updateBookTimestamp(bookId);
        // Queue the deletion of the old and update of the new
        const newRecord = await getNodeChunkFromIndexedDB(bookId, newId);
        if (newRecord) {
          queueForSync("nodes", newId, "update", newRecord);
        }
        queueForSync("nodes", oldId, "delete");
        resolve(true);
      };
      tx.onerror = () => {
        clearTimeout(timeoutId);
        console.error("Transaction error during normalization:", tx.error);
        reject(tx.error);
      };
      tx.onabort = (e) => {
        clearTimeout(timeoutId);
        console.warn("Transaction aborted:", e);
        reject(new Error("Transaction aborted"));
      };
    });
  });
}
