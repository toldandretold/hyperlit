/**
 * Node Write Operations Module
 * Handles creating, updating, and deleting individual nodes
 */

import { openDatabase } from '../core/connection';
import { parseNodeId } from '../core/utilities';
import { LATEST, type BookId, type ChunkId, type NodeRecord, type QueueForSyncFn } from '../types';

interface WriteDeps {
  withPending: <T>(fn: () => Promise<T>) => Promise<T>;
  book: BookId | null | undefined;
  updateBookTimestamp: (bookId: BookId) => Promise<unknown>;
  queueForSync: QueueForSyncFn;
}

// Injected dependencies (crash-if-uninitialized, same as the pre-TS module)
let withPending: WriteDeps['withPending'];
let book: WriteDeps['book'];
let updateBookTimestamp: WriteDeps['updateBookTimestamp'];
let queueForSync: WriteDeps['queueForSync'];

// Initialization function to inject dependencies
export function initNodeWriteDependencies(deps: WriteDeps): void {
  withPending = deps.withPending;
  book = deps.book;
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
}

/** A renumbering instruction: move oldStartLine → newStartLine with this content. */
export interface RenumberUpdate {
  oldStartLine: number;
  newStartLine: number;
  chunk_id: ChunkId;
  content: string;
  node_id: string | null;
  hyperlights?: NodeRecord['hyperlights'];
  hypercites?: NodeRecord['hypercites'];
  footnotes?: NodeRecord['footnotes'];
}

/**
 * Add a single node to IndexedDB
 *
 * @param transaction - Optional existing transaction (SHARED mode: caller owns completion)
 */
export async function addNodeToIndexedDB(
  bookId: BookId,
  startLine: string | number,
  content: string,
  chunkId = 0,
  nodeId: string | null = null,
  transaction: IDBTransaction | null = null,
): Promise<boolean> {
  return withPending(async () => {
    try {
      const numericStartLine = parseNodeId(startLine);

      let tx: IDBTransaction;
      let store: IDBObjectStore;

      if (transaction) {
        // SHARED MODE: Use the provided transaction.
        tx = transaction;
        store = tx.objectStore("nodes");
      } else {
        // STANDALONE MODE: We open our own database and create a transaction.
        const db = await openDatabase();
        tx = db.transaction(["nodes"], "readwrite");
        store = tx.objectStore("nodes");
      }

      // Extract node_id from data-node-id attribute if not provided
      let extractedNodeId: string | null | undefined = nodeId;
      if (!extractedNodeId && content) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        const firstElement = tempDiv.firstElementChild;
        extractedNodeId = firstElement?.getAttribute('data-node-id');
      }

      const nodeRecord = {
        book: bookId,
        startLine: numericStartLine,
        chunk_id: chunkId,
        node_id: extractedNodeId || null,
        content: content,
        hyperlights: [],
        hypercites: [],
      };

      store.put(nodeRecord);

      // If we are in STANDALONE mode (we created our own transaction),
      // we are responsible for awaiting its completion.
      if (!transaction) {
        return new Promise<boolean>((resolve, reject) => {
          tx.oncomplete = () => {
            resolve(true);
          };
          tx.onerror = () => {
            console.error("❌ Error adding node:", tx.error);
            reject(tx.error);
          };
          tx.onabort = (e) => {
            console.error("❌ Transaction aborted:", e);
            reject(new Error("Transaction aborted"));
          };
        });
      } else {
        // If we are in SHARED mode, the caller is responsible for the transaction.
        return true; // Resolve immediately.
      }
    } catch (err) {
      console.error("❌ Failed to add node:", err);
      throw err;
    }
  });
}

/**
 * Save all nodes to IndexedDB (bulk operation).
 * Stamps each record with the book and a numeric startLine before writing.
 */
export async function saveAllNodesToIndexedDB(
  nodes: Array<{ startLine: string | number } & Record<string, unknown>>,
  bookId: BookId = LATEST,
  onComplete?: () => void,
): Promise<void> {
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("nodes", "readwrite");
    const store = tx.objectStore("nodes");

    nodes.forEach((record) => {
      record.book = bookId;
      record.startLine = parseNodeId(record.startLine);
      store.put(record);
    });

    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ Nodes successfully saved to nodes object store in IndexedDB for book:", bookId);
        try {
          await updateBookTimestamp(bookId);
          // NOTE: Auto-sync to PostgreSQL removed - the debouncedMasterSync system
          // handles all syncing via queueForSync() when actual edits occur.
          // This prevents the dangerous DELETE ALL + INSERT pattern from running
          // when loading data FROM PostgreSQL into IndexedDB.
        } catch (err) {
          console.warn(
            "⚠️ post-save hook failed (timestamp update):",
            err
          );
        } finally {
          if (onComplete) {
            try {
              onComplete();
            } catch (_) {}
          }
          resolve();
        }
      };
      tx.onerror = () => {
        console.error("❌ Error saving nodes to nodes object store in IndexedDB");
        reject();
      };
    });
  });
}

/**
 * Delete all nodes after a specific node ID
 * (exclusive lower bound — the anchor node itself is kept)
 */
export async function deleteNodesAfter(book: BookId, afterNodeId: string | number): Promise<void> {
  const numericAfter = parseNodeId(afterNodeId);

  try {
    const db = await openDatabase();
    const tx = db.transaction(["nodes"], "readwrite");
    const store = tx.objectStore("nodes");

    // lower = [book, after], upper = [book, +∞]
    const range = IDBKeyRange.bound(
      [book, numericAfter],
      [book, Number.MAX_SAFE_INTEGER],
      /*lowerOpen=*/ true,  // EXCLUDE afterNodeId from deletion (only delete nodes AFTER it)
      /*upperOpen=*/ false
    );

    const cursorReq = store.openCursor(range);
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };

    return await new Promise((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Connection unavailable — silently skip, same as the raw-open era
  }
}

/**
 * Add a new book to IndexedDB (wrapper around addNodeToIndexedDB)
 * This is just a convenience function for creating new books
 */
export async function addNewBookToIndexedDB(
  bookId: BookId,
  startLine: string | number,
  content: string,
  chunkId = 0,
  transaction: IDBTransaction | null = null,
): Promise<boolean> {
  // This is just an alias for addNodeToIndexedDB
  // "Adding a new book" is really just adding nodes
  return addNodeToIndexedDB(bookId, startLine, content, chunkId, null, transaction);
}

/**
 * Renumber all nodes in IndexedDB by deleting old records and creating new ones
 * Used during system-wide renumbering operations
 */
export async function renumberNodesInIndexedDB(updates: RenumberUpdate[], bookId: BookId): Promise<void> {
  console.log(`🔄 Renumbering ${updates.length} nodes in IndexedDB`);

  const db = await openDatabase();
  const tx = db.transaction("nodes", "readwrite");
  const store = tx.objectStore("nodes");

  return new Promise((resolve, reject) => {
    // Step 1: Delete all old records
    const deletePromises = updates.map(update => {
      return new Promise<void>((resolveDelete, rejectDelete) => {
        const deleteReq = store.delete([bookId, update.oldStartLine]);
        deleteReq.onsuccess = () => resolveDelete();
        deleteReq.onerror = () => rejectDelete(deleteReq.error);
      });
    });

    Promise.all(deletePromises).then(() => {
      console.log('✅ Deleted old records');

      // Step 2: Add all new records
      const addPromises = updates.map(update => {
        return new Promise<void>((resolveAdd, rejectAdd) => {
          const newRecord = {
            book: bookId,
            startLine: update.newStartLine,
            chunk_id: update.chunk_id,
            content: update.content,
            node_id: update.node_id,
            hyperlights: update.hyperlights || [],
            hypercites: update.hypercites || [],
            footnotes: update.footnotes || []
          };

          const addReq = store.add(newRecord);
          addReq.onsuccess = () => resolveAdd();
          addReq.onerror = () => rejectAdd(addReq.error);
        });
      });

      return Promise.all(addPromises);
    }).then(() => {
      console.log('✅ Added new renumbered records');
      resolve();
    }).catch(error => {
      console.error('❌ Renumbering error:', error);
      reject(error);
    });

    tx.oncomplete = () => {
      console.log('✅ Renumbering transaction complete');
    };

    tx.onerror = () => {
      console.error('❌ Renumbering transaction error:', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Write nodes directly to IndexedDB (bulk operation)
 * Simple helper for writing pre-formatted chunks
 *
 * NOTE: This is a PURE IndexedDB operation - does NOT sync to PostgreSQL
 * Original implementation from indexedDB.js - logic preserved exactly
 */
export async function writeNodes(chunks: NodeRecord[]): Promise<void> {
  if (!chunks || chunks.length === 0) {
    return;
  }

  try {
    const db = await openDatabase();
    const tx = db.transaction(["nodes"], "readwrite");
    const store = tx.objectStore("nodes");

    for (const chunk of chunks) {
      // chunk must have the composite key fields (book, startLine) already on it
      store.put(chunk);
    }

    return await new Promise((resolve) => {
      tx.oncomplete = () => {
        console.log(`✅ Wrote ${chunks.length} chunks to IndexedDB`);
        resolve();
      };
      tx.onerror = () => {
        console.error('❌ Error in writeNodes transaction');
        resolve();
      };
    });
  } catch {
    console.error('❌ Error opening database for writeNodes');
  }
}
