/**
 * Database Cleanup Utilities Module
 * Functions for clearing/resetting IndexedDB data
 */

import { openDatabase } from '../core/connection';
import type { BookId } from '../types';

/**
 * Clear all data from all object stores in IndexedDB
 * Useful for logging out or resetting the application state
 */
export async function clearDatabase(): Promise<void> {
  console.log("🧹 Clearing all IndexedDB data...");
  try {
    const db = await openDatabase();
    const storeNames = Array.from(db.objectStoreNames);

    if (storeNames.length === 0) {
      console.log("ℹ️ IndexedDB is already empty.");
      return;
    }

    const tx = db.transaction(storeNames, "readwrite");
    const promises = storeNames.map(name => {
      return new Promise<void>((resolve, reject) => {
        const store = tx.objectStore(name);
        const request = store.clear();
        request.onsuccess = () => {
          console.log(`  - Cleared store: ${name}`);
          resolve();
        };
        request.onerror = () => {
          console.error(`  - Error clearing store ${name}:`, request.error);
          reject(request.error);
        };
      });
    });

    await Promise.all(promises);
    console.log("✅ All IndexedDB stores cleared successfully");
  } catch (error) {
    console.error("❌ Error clearing IndexedDB:", error);
    throw error;
  }
}

/**
 * Clear content (nodes, footnotes, bibliography) for a specific book from IndexedDB
 * but preserve the library record, hyperlights, and hypercites.
 * Also clears sub-book data (e.g. footnote sub-books with IDs like "bookId/Fn...").
 */
export async function clearBookContentFromIndexedDB(bookId: BookId): Promise<void> {
  console.log(`Clearing content for "${bookId}" from IndexedDB...`);
  try {
    const db = await openDatabase();
    const contentStores = ['nodes', 'footnotes', 'bibliography'];
    const tx = db.transaction([...contentStores, 'library'], 'readwrite');

    for (const storeName of contentStores) {
      const store = tx.objectStore(storeName);
      const index = store.index('book');

      // Delete main book records
      await cursorDelete(index.openCursor(IDBKeyRange.only(bookId)));

      // Delete sub-book records (bookId/ ... bookId/\uffff)
      await cursorDelete(index.openCursor(
        IDBKeyRange.bound(bookId + '/', bookId + '/\uffff')
      ));
    }

    // Delete sub-book library records (but NOT the main library record)
    const libStore = tx.objectStore('library');
    await cursorDelete(libStore.openCursor(
      IDBKeyRange.bound(bookId + '/', bookId + '/\uffff')
    ));

    console.log(`Content cleared for "${bookId}"`);
  } catch (error) {
    console.error(`Error clearing content for "${bookId}":`, error);
    throw error;
  }
}

function cursorDelete(request: IDBRequest<IDBCursorWithValue | null>): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete all data for a specific book from IndexedDB
 * Used when deleting a book from the user profile page
 */
export async function deleteBookFromIndexedDB(
  bookId: BookId,
): Promise<{ success: boolean; bookId: BookId; deleted: Record<string, number> }> {
  console.log(`🧹 Deleting book "${bookId}" from IndexedDB...`);

  try {
    const db = await openDatabase();
    const deleted: Record<string, number> = {};

    // Stores with "book" index
    const storesWithBookIndex = ['nodes', 'hyperlights', 'hypercites', 'footnotes', 'bibliography'];

    const tx = db.transaction([...storesWithBookIndex, 'library'], 'readwrite');

    // Delete from stores using "book" index (main book + sub-books)
    const subRange = IDBKeyRange.bound(bookId + '/', bookId + '/\uffff');

    for (const storeName of storesWithBookIndex) {
      const store = tx.objectStore(storeName);
      const index = store.index('book');

      // Delete main book records
      let count = 0;
      const request = index.openCursor(IDBKeyRange.only(bookId));
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            count++;
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });

      // Also delete sub-book records (bookId/ ... bookId/\uffff)
      await new Promise<void>((resolve, reject) => {
        const subRequest = index.openCursor(subRange);
        subRequest.onsuccess = () => {
          const cursor = subRequest.result;
          if (cursor) {
            cursor.delete();
            count++;
            cursor.continue();
          } else {
            resolve();
          }
        };
        subRequest.onerror = () => reject(subRequest.error);
      });

      deleted[storeName] = count;
      console.log(`  - Deleted ${count} records from ${storeName}`);
    }

    // Delete library metadata (keyPath is "book")
    const libraryStore = tx.objectStore('library');
    await new Promise<void>((resolve, reject) => {
      const request = libraryStore.delete(bookId);
      request.onsuccess = () => {
        deleted.library = 1;
        console.log(`  - Deleted library record`);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    // Delete sub-book library records
    await cursorDelete(libraryStore.openCursor(subRange));

    console.log(`✅ Book "${bookId}" deleted from IndexedDB`);
    return { success: true, bookId, deleted };

  } catch (error) {
    console.error(`❌ Error deleting book "${bookId}" from IndexedDB:`, error);
    throw error;
  }
}
