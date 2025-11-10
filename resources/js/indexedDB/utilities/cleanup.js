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
