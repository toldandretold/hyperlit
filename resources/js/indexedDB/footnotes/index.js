/**
 * Footnotes Operations Module
 * Handles footnote operations in IndexedDB
 */

import { openDatabase } from '../core/connection.js';
import { syncFootnotesToPostgreSQL } from './syncFootnotesToPostgreSQL.js';

// Import from the main indexedDB file (temporary until fully refactored)
let updateBookTimestamp, withPending;

// Initialization function to inject dependencies
export function initFootnotesDependencies(deps) {
  updateBookTimestamp = deps.updateBookTimestamp;
  withPending = deps.withPending;
}

/**
 * Get footnotes data for a book from IndexedDB
 *
 * @param {string} bookId - Book identifier
 * @returns {Promise<Object|null>} Footnotes data or null
 */
export async function getFootnotesFromIndexedDB(bookId = "latest") {
  try {
    const db = await openDatabase();
    // Log the object store names to ensure "footnotes" exists.
    console.log("Database object stores:", Array.from(db.objectStoreNames));
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains("footnotes")) {
        console.warn(
          "⚠️ 'footnotes' object store is missing after initialization."
        );
        return resolve(null);
      }
      const transaction = db.transaction(["footnotes"], "readonly");
      const store = transaction.objectStore("footnotes");
      let getRequest = store.get(bookId);
      getRequest.onsuccess = () => {
        console.log(`Data retrieved for key "${bookId}":`, getRequest.result);
        resolve(getRequest.result?.data || null);
      };
      getRequest.onerror = (event) => {
        console.error(
          "❌ Error retrieving data from IndexedDB for key:",
          bookId,
          event
        );
        resolve(null);
      };
    });
  } catch (error) {
    console.error("❌ Error in getFootnotesFromIndexedDB:", error);
    return null;
  }
}

/**
 * Save footnotes data for a book to IndexedDB
 *
 * @param {Object} footnotesData - Footnotes data to save
 * @param {string} bookId - Book identifier
 * @returns {Promise<void>}
 */
export async function saveFootnotesToIndexedDB(footnotesData, bookId = "latest") {
  console.log("🙏 Attempting to save to 'footnotes' object store in IndexedDB...");

  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains("footnotes")) {
        console.warn("⚠️ Cannot save: 'footnotes' store missing.");
        return reject("Object store missing");
      }

      const transaction = db.transaction(["footnotes"], "readwrite");
      const store = transaction.objectStore("footnotes");

      const dataToSave = {
        book: bookId,
        data: footnotesData,
      };

      const request = store.put(dataToSave);

      request.onsuccess = async() => {
        console.log("✅ Successfully saved footnotes to IndexedDB.");
        // This correctly queues the library update for the debounced sync.
        await updateBookTimestamp(bookId);
        resolve();
      };

      request.onerror = () => {
        console.error("❌ Failed to save footnotes to IndexedDB.");
        reject("Failed to save footnotes to IndexedDB");
      };
    });
  } catch (error) {
    console.error("❌ Error opening database:", error);
    throw error;
  }
}

/**
 * Save an array of footnote objects to IndexedDB (bulk operation)
 * Then syncs to PostgreSQL
 *
 * @param {Array} footnotes - Array of footnote objects
 * @param {string} bookId - Book identifier
 * @returns {Promise<void>}
 */
export async function saveAllFootnotesToIndexedDB(footnotes, bookId) {
  if (!footnotes || footnotes.length === 0) return;
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("footnotes", "readwrite");
    const store = tx.objectStore("footnotes");

    footnotes.forEach((footnote) => {
      const record = { ...footnote, book: bookId };
      store.put(record);
    });

    return new Promise((resolve, reject) => {
      // Make the oncomplete handler async to use await
      tx.oncomplete = async () => {
        console.log(
          `✅ ${footnotes.length} footnotes successfully saved to IndexedDB for book: ${bookId}`
        );

        // --- ADDED: Trigger the sync to PostgreSQL ---
        try {
          // syncFootnotesToPostgreSQL already imported statically
          await syncFootnotesToPostgreSQL(bookId, footnotes);
        } catch (err) {
          // Log the error but don't reject the promise, as the local save was successful.
          console.warn("⚠️ Footnote sync to PostgreSQL failed:", err);
        }
        // --- END ADDED ---

        resolve();
      };
      tx.onerror = (e) => {
        console.error("❌ Error saving footnotes to IndexedDB:", e.target.error);
        reject(e.target.error);
      };
    });
  });
}

// PostgreSQL Sync
export {
  syncFootnotesToPostgreSQL,
} from './syncFootnotesToPostgreSQL.js';
