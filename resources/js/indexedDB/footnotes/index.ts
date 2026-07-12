/**
 * Footnotes Operations Module
 * Handles footnote operations in IndexedDB
 */

import { openDatabase } from '../core/connection';
import { syncFootnotesToPostgreSQL } from './syncFootnotesToPostgreSQL';
import { verbose } from '../../utilities/logger';
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

        // --- Trigger the sync to PostgreSQL ---
        // BUT NOT during a paste into a fresh book: the eager sync fires from this
        // tx.oncomplete before the book's `library` row exists server-side (the
        // bulk-create POST is still in flight), so the footnotes RLS insert policy
        // rejects it with a 500. paste/index.ts:syncPasteToPostgreSQL pushes footnotes
        // AFTER the initial book-creation sync resolves, so skipping here is safe and
        // avoids the doomed request + console-error noise. See §"paste-subbook-rls".
        const { isPasteInProgress } = await import('../../utilities/operationState');
        if (isPasteInProgress()) {
          verbose.content('Skipping eager footnote sync during paste — syncPasteToPostgreSQL will push it', 'indexedDB/footnotes');
        } else {
          try {
            // syncFootnotesToPostgreSQL already imported statically
            await syncFootnotesToPostgreSQL(bookId, footnotes);
          } catch (err) {
            // Log the error but don't reject the promise, as the local save was successful.
            console.warn("⚠️ Footnote sync to PostgreSQL failed:", err);
          }
        }
        // --- END ---

        resolve();
      };
      tx.onerror = () => {
        console.error("❌ Error saving footnotes to IndexedDB:", tx.error);
        reject(tx.error);
      };
    });
  });
}

/**
 * Read every footnote row for a book from IndexedDB.
 *
 * The store is keyed `[book, footnoteId]`, so a book's rows are the contiguous
 * range `[book] … [book, "￿"]`. Used by the post-paste sync to push
 * paste-seeded footnotes once the book exists server-side.
 */
export async function getAllFootnotesForBook(bookId: BookId): Promise<FootnoteRecord[]> {
  const db = await openDatabase();
  return new Promise<FootnoteRecord[]>((resolve, reject) => {
    const tx = db.transaction("footnotes", "readonly");
    const store = tx.objectStore("footnotes");
    const range = IDBKeyRange.bound([bookId], [bookId, "￿"]);
    const request = store.getAll(range);
    request.onsuccess = () => resolve((request.result as FootnoteRecord[]) || []);
    request.onerror = () => reject(request.error);
  });
}

// PostgreSQL Sync
export {
  syncFootnotesToPostgreSQL,
} from './syncFootnotesToPostgreSQL';
