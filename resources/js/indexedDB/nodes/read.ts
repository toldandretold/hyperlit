/**
 * Node Read Operations Module
 * Handles reading node chunks from IndexedDB
 */

import { openDatabase } from '../core/connection';
import { parseNodeId } from '../core/utilities';
import { verbose } from '../../utilities/logger';
import type { BookId, NodeRecord } from '../types';

/**
 * Get all node chunks for a book, sorted by chunk_id
 * Used for lazy loading
 */
export async function getNodeChunksFromIndexedDB(bookId: BookId = "latest"): Promise<NodeRecord[]> {
  verbose.content(`Fetching nodes from IndexedDB: ${bookId}`, '/indexedDB/nodes/read.js');

  const db = await openDatabase();
  const tx = db.transaction("nodes", "readonly");
  const store = tx.objectStore("nodes");

  return new Promise((resolve, reject) => {
    // Use the book index for more efficient lookup
    const index = store.index("book");
    const request = index.getAll(bookId);

    request.onsuccess = () => {
      const results: NodeRecord[] = request.result || [];

      // Sort the results by chunk_id for proper lazy loading order
      results.sort((a, b) => a.chunk_id - b.chunk_id);

      verbose.content(`Retrieved ${results.length} nodes for: ${bookId}`, '/indexedDB/nodes/read.js');
      resolve(results);
    };

    request.onerror = () => {
      reject("❌ Error loading nodes from nodes object store in IndexedDB");
    };
  });
}

/**
 * Get all node chunks for a book, sorted by startLine
 * Used for renumbering operations
 */
export async function getAllNodeChunksForBook(bookId: BookId): Promise<NodeRecord[]> {
  console.log("Fetching ALL nodes from nodes object store in IndexedDB for renumbering, book:", bookId);

  const db = await openDatabase();
  const tx = db.transaction("nodes", "readonly");
  const store = tx.objectStore("nodes");

  return new Promise((resolve, reject) => {
    const index = store.index("book");
    const request = index.getAll(bookId);

    request.onsuccess = () => {
      const results: NodeRecord[] = request.result || [];

      // Sort by startLine to preserve document order
      results.sort((a, b) => a.startLine - b.startLine);

      console.log(`✅ Retrieved ${results.length} nodes from nodes object store in IndexedDB for renumbering`);
      resolve(results);
    };

    request.onerror = () => {
      console.error("❌ Error loading nodes from nodes object store in IndexedDB for renumbering");
      reject("❌ Error loading nodes from nodes object store in IndexedDB");
    };
  });
}

/**
 * Get a single node chunk by book and startLine
 *
 * Uses the shared connection singleton (unified 2026-06 from a raw per-call
 * indexedDB.open — see read.test.js, which pins the observable behavior:
 * missing keys resolve to undefined (IDB get semantics), errors → null).
 */
export async function getNodeChunkFromIndexedDB(book: BookId, startLine: string | number): Promise<NodeRecord | null | undefined> {
  const numericStartLine = parseNodeId(startLine);
  try {
    const db = await openDatabase();
    const tx = db.transaction(["nodes"], "readonly");
    const getRequest = tx.objectStore("nodes").get([book, numericStartLine]);

    return await new Promise((resolve) => {
      getRequest.onsuccess = () => {
        resolve(getRequest.result);
      };
      getRequest.onerror = () => {
        console.error('Error getting nodeChunk:', getRequest.error);
        resolve(null);
      };
    });
  } catch (error) {
    console.error('IndexedDB error:', error);
    return null;
  }
}

/**
 * Get all node chunks after a specific node ID
 * (exclusive lower bound — the anchor node itself is not returned)
 */
export async function getNodeChunksAfter(book: BookId, afterNodeId: string | number): Promise<NodeRecord[]> {
  const numericAfter = parseNodeId(afterNodeId);

  try {
    const db = await openDatabase();
    const tx = db.transaction(["nodes"], "readonly");
    const store = tx.objectStore("nodes");

    // lower bound is ["book", afterLine]
    // upper bound is ["book", +∞] -- Number.MAX_SAFE_INTEGER is usually enough
    const range = IDBKeyRange.bound([book, numericAfter], [book, Number.MAX_SAFE_INTEGER], /*lowerOpen=*/true, /*upperOpen=*/false);  // EXCLUDE afterNodeId (only get nodes AFTER it)

    const cursorReq = store.openCursor(range);
    const results: NodeRecord[] = [];

    return await new Promise((resolve) => {
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (!cur) return;          // done
        results.push(cur.value);
        cur.continue();
      };

      tx.oncomplete = () => resolve(results);
      tx.onerror = () => resolve(results);
    });
  } catch {
    return [];
  }
}
