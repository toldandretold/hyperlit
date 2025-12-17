/**
 * Database Cleanup Utilities Module
 * Functions for clearing/resetting IndexedDB data
 */

import { openDatabase } from '../core/connection.js';

/**
 * Clear all data from all object stores in IndexedDB
 * Useful for logging out or resetting the application state
 *
 * @returns {Promise<void>}
 */
export async function clearDatabase() {
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
      return new Promise((resolve, reject) => {
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
 * Delete all data for a specific book from IndexedDB
 * Used when deleting a book from the user profile page
 *
 * @param {string} bookId - The book ID to delete
 * @returns {Promise<{success: boolean, bookId: string, deleted: Object}>}
 */
export async function deleteBookFromIndexedDB(bookId) {
  console.log(`🧹 Deleting book "${bookId}" from IndexedDB...`);

  try {
    const db = await openDatabase();
    const deleted = {};

    // Stores with "book" index
    const storesWithBookIndex = ['nodes', 'hyperlights', 'hypercites', 'footnotes', 'bibliography'];

    const tx = db.transaction([...storesWithBookIndex, 'library'], 'readwrite');

    // Delete from stores using "book" index
    for (const storeName of storesWithBookIndex) {
      const store = tx.objectStore(storeName);
      const index = store.index('book');
      const range = IDBKeyRange.only(bookId);

      let count = 0;
      const request = index.openCursor(range);

      await new Promise((resolve, reject) => {
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            count++;
            cursor.continue();
          } else {
            deleted[storeName] = count;
            console.log(`  - Deleted ${count} records from ${storeName}`);
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });
    }

    // Delete library metadata (keyPath is "book")
    const libraryStore = tx.objectStore('library');
    await new Promise((resolve, reject) => {
      const request = libraryStore.delete(bookId);
      request.onsuccess = () => {
        deleted.library = 1;
        console.log(`  - Deleted library record`);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    console.log(`✅ Book "${bookId}" deleted from IndexedDB`);
    return { success: true, bookId, deleted };

  } catch (error) {
    console.error(`❌ Error deleting book "${bookId}" from IndexedDB:`, error);
    throw error;
  }
}
