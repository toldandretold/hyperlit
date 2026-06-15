/**
 * Hypercites Read Module (leaf)
 *
 * Zero-import-from-siblings read primitive — broken out of ./index so that
 * ./helpers can use it WITHOUT a static import cycle (helpers → index → helpers).
 * Imports only from ../core/*.
 */

import { openDatabase } from '../core/connection';
import type { BookId, HyperciteRecord } from '../types';

/**
 * Get a hypercite from IndexedDB
 * (shared connection singleton — missing key → undefined, errors → null;
 * pinned in hypercites.test.js)
 */
export async function getHyperciteFromIndexedDB(book: BookId, hyperciteId: string): Promise<HyperciteRecord | null | undefined> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(["hypercites"], "readonly");

    // Get the record using the composite key [book, hyperciteId]
    const getRequest = tx.objectStore("hypercites").get([book, hyperciteId]);

    return await new Promise((resolve) => {
      getRequest.onsuccess = () => {
        resolve(getRequest.result);
      };
      getRequest.onerror = () => {
        console.error(`Error getting hypercite record:`, getRequest.error);
        resolve(null);
      };
    });
  } catch (error) {
    console.error("Transaction error:", error);
    return null;
  }
}
