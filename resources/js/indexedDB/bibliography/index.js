/**
 * References (Bibliography) Operations Module
 * Handles reference/bibliography operations in IndexedDB
 */

import { openDatabase } from '../core/connection.js';
import { syncReferencesToPostgreSQL } from './syncReferencesToPostgreSQL.js';

// Import from the main indexedDB file (temporary until fully refactored)
let withPending;

// Initialization function to inject dependencies
export function initReferencesDependencies(deps) {
  withPending = deps.withPending;
}

/**
 * Save an array of reference objects to IndexedDB (bulk operation)
 * Then syncs to PostgreSQL
 *
 * @param {Array} references - Array of reference objects
 * @param {string} bookId - Book identifier
 * @returns {Promise<void>}
 */
export async function saveAllReferencesToIndexedDB(references, bookId) {
  if (!references || references.length === 0) return;
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("bibliography", "readwrite");
    const store = tx.objectStore("bibliography");

    references.forEach((reference) => {
      const record = { ...reference, book: bookId };
      store.put(record);
    });

    return new Promise((resolve, reject) => {
      // Make the oncomplete handler async to use await
      tx.oncomplete = async () => {
        console.log(
          `✅ ${references.length} references successfully saved to IndexedDB for book: ${bookId}`
        );

        // --- ADDED: Trigger the sync to PostgreSQL ---
        try {
          // syncReferencesToPostgreSQL already imported statically
          await syncReferencesToPostgreSQL(bookId, references);
        } catch (err) {
          console.warn("⚠️ Reference sync to PostgreSQL failed:", err);
        }
        // --- END ADDED ---

        resolve();
      };
      tx.onerror = (e) => {
        console.error("❌ Error saving references to IndexedDB:", e.target.error);
        reject(e.target.error);
      };
    });
  });
}

// PostgreSQL Sync
export {
  syncReferencesToPostgreSQL,
} from './syncReferencesToPostgreSQL.js';
