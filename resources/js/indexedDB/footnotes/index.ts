/**
 * Footnotes Operations Module
 * Handles footnote operations in IndexedDB
 */

import { openDatabase } from '../core/connection';
import { syncFootnotesToPostgreSQL } from './syncFootnotesToPostgreSQL';
import type { BookId, FootnoteRecord } from '../types';

interface FootnotesDeps {
  updateBookTimestamp: (bookId: BookId) => Promise<unknown>;
  withPending: <T>(fn: () => Promise<T>) => Promise<T>;
}

// Injected dependencies (crash-if-uninitialized, same as the pre-TS module)
let updateBookTimestamp: FootnotesDeps['updateBookTimestamp'];
let withPending: FootnotesDeps['withPending'];

// Initialization function to inject dependencies
export function initFootnotesDependencies(deps: FootnotesDeps): void {
  updateBookTimestamp = deps.updateBookTimestamp;
  withPending = deps.withPending;
}

/**
 * Save an array of footnote objects to IndexedDB (bulk operation)
 * Then syncs to PostgreSQL (sync failure is swallowed — local save wins)
 */
export async function saveAllFootnotesToIndexedDB(footnotes: FootnoteRecord[], bookId: BookId): Promise<void> {
  if (!footnotes || footnotes.length === 0) return;
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("footnotes", "readwrite");
    const store = tx.objectStore("footnotes");

    footnotes.forEach((footnote) => {
      const record = { ...footnote, book: bookId };
      store.put(record);
    });

    return new Promise<void>((resolve, reject) => {
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
      tx.onerror = () => {
        console.error("❌ Error saving footnotes to IndexedDB:", tx.error);
        reject(tx.error);
      };
    });
  });
}

// PostgreSQL Sync
export {
  syncFootnotesToPostgreSQL,
} from './syncFootnotesToPostgreSQL';
