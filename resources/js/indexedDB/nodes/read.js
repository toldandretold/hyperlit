/**
 * Node Read Operations Module
 * Handles reading node chunks from IndexedDB
 */

import { openDatabase } from '../core/connection.js';
import { parseNodeId, toPublicChunk } from '../core/utilities.js';
import { verbose } from '../../utilities/logger.js';

/**
 * Get all node chunks for a book, sorted by chunk_id
 * Used for lazy loading
 *
 * @param {string} bookId - Book identifier
 * @returns {Promise<Array>} Array of node chunks
 */
export async function getNodeChunksFromIndexedDB(bookId = "latest") {
  verbose.content(`Fetching nodes from IndexedDB: ${bookId}`, '/indexedDB/nodes/read.js');

  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readonly");
  const store = tx.objectStore("nodeChunks");

  return new Promise((resolve, reject) => {
    // Use the book index for more efficient lookup
    const index = store.index("book");
    const request = index.getAll(bookId);

    request.onsuccess = () => {
      let results = request.result || [];

      // Sort the results by chunk_id for proper lazy loading order
      results.sort((a, b) => a.chunk_id - b.chunk_id);

      verbose.content(`Retrieved ${results.length} nodes for: ${bookId}`, '/indexedDB/nodes/read.js');
      resolve(results);
    };

    request.onerror = () => {
      reject("❌ Error loading nodes from nodeChunks object store in IndexedDB");
    };
  });
}

/**
 * Get all node chunks for a book, sorted by startLine
 * Used for renumbering operations
 *
 * @param {string} bookId - Book identifier
 * @returns {Promise<Array>} Array of node chunks sorted by startLine
 */
export async function getAllNodeChunksForBook(bookId) {
  console.log("Fetching ALL nodes from nodeChunks object store in IndexedDB for renumbering, book:", bookId);

  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readonly");
  const store = tx.objectStore("nodeChunks");

  return new Promise((resolve, reject) => {
    const index = store.index("book");
    const request = index.getAll(bookId);

    request.onsuccess = () => {
      let results = request.result || [];

      // Sort by startLine to preserve document order
      results.sort((a, b) => a.startLine - b.startLine);

      console.log(`✅ Retrieved ${results.length} nodes from nodeChunks object store in IndexedDB for renumbering`);
      resolve(results);
    };

    request.onerror = () => {
      console.error("❌ Error loading nodes from nodeChunks object store in IndexedDB for renumbering");
      reject("❌ Error loading nodes from nodeChunks object store in IndexedDB");
    };
  });
}

/**
 * Get a single node chunk by book and startLine
 *
 * @param {string} book - Book identifier
 * @param {string|number} startLine - Starting line/node ID
 * @returns {Promise<Object|null>} Node chunk or null
 */
export async function getNodeChunkFromIndexedDB(book, startLine) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";

    const numericStartLine = parseNodeId(startLine);
    const request = indexedDB.open(dbName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction([storeName], "readonly");
      const objectStore = transaction.objectStore(storeName);

      const key = [book, numericStartLine];
      const getRequest = objectStore.get(key);

      getRequest.onsuccess = (event) => {
        resolve(event.target.result);
      };

      getRequest.onerror = (event) => {
        console.error('Error getting nodeChunk:', event.target.error);
        resolve(null);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    };

    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      resolve(null);
    };
  });
}

/**
 * Get all node chunks after a specific node ID
 *
 * @param {string} book - Book identifier
 * @param {string|number} afterNodeId - Node ID to start after
 * @returns {Promise<Array>} Array of node chunks
 */
export async function getNodeChunksAfter(book, afterNodeId) {
  const numericAfter = parseNodeId(afterNodeId);
  const dbName = "MarkdownDB";
  const storeName = "nodeChunks";

  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve([]);

    openReq.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction([storeName], "readonly");
      const store = tx.objectStore(storeName);

      // lower bound is ["book", afterLine]
      const lower = [book, numericAfter];
      // upper bound is ["book", +∞] -- Number.MAX_SAFE_INTEGER is usually enough
      const upper = [book, Number.MAX_SAFE_INTEGER];
      const range = IDBKeyRange.bound(lower, upper, /*lowerOpen=*/false, /*upperOpen=*/false);

      const cursorReq = store.openCursor(range);
      const results = [];

      cursorReq.onsuccess = (evt) => {
        const cur = evt.target.result;
        if (!cur) return;          // done
        results.push(cur.value);
        cur.continue();
      };

      tx.oncomplete = () => {
        db.close();
        resolve(results);
      };
      tx.onerror = () => {
        db.close();
        resolve(results);
      };
    };
  });
}
