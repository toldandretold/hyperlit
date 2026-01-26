/**
 * Node Write Operations Module
 * Handles creating, updating, and deleting individual node chunks
 */

import { openDatabase } from '../core/connection.js';
import { parseNodeId } from '../core/utilities.js';

// Import from the main indexedDB file (temporary until fully refactored)
// These will be extracted to their respective modules
let withPending, book, updateBookTimestamp, queueForSync;

// Initialization function to inject dependencies
export function initNodeWriteDependencies(deps) {
  withPending = deps.withPending;
  book = deps.book;
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
}

/**
 * Helper function to determine chunk_id from the DOM
 */
function determineChunkIdFromDOM(nodeId) {
  const node = document.getElementById(nodeId);
  if (node) {
    const chunkIdAttr = node.getAttribute('data-chunk-id');
    if (chunkIdAttr) {
      return parseInt(chunkIdAttr);
    }
  }
  return 0; // Default fallback
}

/**
 * Add a single node chunk to IndexedDB
 *
 * @param {string} bookId - Book identifier
 * @param {string|number} startLine - Starting line/node ID
 * @param {string} content - HTML content
 * @param {number} chunkId - Chunk identifier for lazy loading
 * @param {string} nodeId - Node UUID
 * @param {IDBTransaction} transaction - Optional existing transaction
 * @returns {Promise<boolean>} Success status
 */
export async function addNodeChunkToIndexedDB(
  bookId,
  startLine,
  content,
  chunkId = 0,
  nodeId = null,
  transaction = null
) {
  return withPending(async () => {
    try {
      const numericStartLine = parseNodeId(startLine);

      let db, tx, store;

      if (transaction) {
        // SHARED MODE: Use the provided transaction.
        tx = transaction;
        store = tx.objectStore("nodes");
      } else {
        // STANDALONE MODE: We open our own database and create a transaction.
        db = await openDatabase();
        tx = db.transaction(["nodes"], "readwrite");
        store = tx.objectStore("nodes");
      }

      // Extract node_id from data-node-id attribute if not provided
      let extractedNodeId = nodeId;
      if (!extractedNodeId && content) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        const firstElement = tempDiv.firstElementChild;
        extractedNodeId = firstElement?.getAttribute('data-node-id');
      }

      const nodeChunkRecord = {
        book: bookId,
        startLine: numericStartLine,
        chunk_id: chunkId,
        node_id: extractedNodeId || null,
        content: content,
        hyperlights: [],
        hypercites: [],
      };

      store.put(nodeChunkRecord);

      // If we are in STANDALONE mode (we created our own transaction),
      // we are responsible for awaiting its completion.
      if (!transaction) {
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => {
            resolve(true);
          };
          tx.onerror = (e) => {
            console.error("❌ Error adding nodeChunk:", e.target.error);
            reject(e.target.error);
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
      console.error("❌ Failed to add nodeChunk:", err);
      throw err;
    }
  });
}

/**
 * Save all node chunks to IndexedDB (bulk operation)
 *
 * @param {Array} nodes - Array of node chunk records
 * @param {string} bookId - Book identifier
 * @param {Function} onComplete - Optional completion callback
 * @returns {Promise<void>}
 */
export async function saveAllNodeChunksToIndexedDB(
  nodes,
  bookId = "latest",
  onComplete
) {
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("nodes", "readwrite");
    const store = tx.objectStore("nodes");

    nodes.forEach((record) => {
      record.book = bookId;
      record.startLine = parseNodeId(record.startLine);
      store.put(record);
    });

    return new Promise((resolve, reject) => {
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
 * Delete all node chunks after a specific node ID
 *
 * @param {string} book - Book identifier
 * @param {string|number} afterNodeId - Node ID to start after
 * @returns {Promise<void>}
 */
export async function deleteNodeChunksAfter(book, afterNodeId) {
  const numericAfter = parseNodeId(afterNodeId);
  const dbName = "MarkdownDB";
  const storeName = "nodes";

  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve();

    openReq.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction([storeName], "readwrite");
      const store = tx.objectStore(storeName);

      // lower = [book, after], upper = [book, +∞]
      const lower = [book, numericAfter];
      const upper = [book, Number.MAX_SAFE_INTEGER];
      const range = IDBKeyRange.bound(
        lower,
        upper,
        /*lowerOpen=*/ true,  // EXCLUDE afterNodeId from deletion (only delete nodes AFTER it)
        /*upperOpen=*/ false
      );

      const cursorReq = store.openCursor(range);
      cursorReq.onsuccess = (evt) => {
        const cur = evt.target.result;
        if (cur) {
          cur.delete();
          cur.continue();
        }
      };

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    };
  });
}

/**
 * Add a new book to IndexedDB (wrapper around addNodeChunkToIndexedDB)
 * This is just a convenience function for creating new books
 *
 * @param {string} bookId - Book identifier
 * @param {string|number} startLine - Starting line/node ID
 * @param {string} content - HTML content
 * @param {number} chunkId - Chunk identifier
 * @param {IDBTransaction} transaction - Optional existing transaction
 * @returns {Promise<boolean>} Success status
 */
export async function addNewBookToIndexedDB(
  bookId,
  startLine,
  content,
  chunkId = 0,
  transaction = null
) {
  // This is just an alias for addNodeChunkToIndexedDB
  // "Adding a new book" is really just adding node chunks
  return addNodeChunkToIndexedDB(bookId, startLine, content, chunkId, null, transaction);
}

/**
 * Renumber all nodes in IndexedDB by deleting old records and creating new ones
 * Used during system-wide renumbering operations
 *
 * @param {Array} updates - Array of update objects with oldStartLine, newStartLine, etc.
 * @param {string} bookId - Book identifier
 * @returns {Promise<void>}
 */
export async function renumberNodeChunksInIndexedDB(updates, bookId) {
  console.log(`🔄 Renumbering ${updates.length} nodes in IndexedDB`);

  const db = await openDatabase();
  const tx = db.transaction("nodes", "readwrite");
  const store = tx.objectStore("nodes");

  return new Promise((resolve, reject) => {
    // Step 1: Delete all old records
    const deletePromises = updates.map(update => {
      return new Promise((resolveDelete, rejectDelete) => {
        const deleteReq = store.delete([bookId, update.oldStartLine]);
        deleteReq.onsuccess = () => resolveDelete();
        deleteReq.onerror = () => rejectDelete(deleteReq.error);
      });
    });

    Promise.all(deletePromises).then(() => {
      console.log('✅ Deleted old records');

      // Step 2: Add all new records
      const addPromises = updates.map(update => {
        return new Promise((resolveAdd, rejectAdd) => {
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

    tx.onerror = (e) => {
      console.error('❌ Renumbering transaction error:', e.target.error);
      reject(e.target.error);
    };
  });
}

/**
 * Write node chunks directly to IndexedDB (bulk operation)
 * Simple helper for writing pre-formatted chunks
 *
 * NOTE: This is a PURE IndexedDB operation - does NOT sync to PostgreSQL
 * Original implementation from indexedDB.js - logic preserved exactly
 *
 * @param {Array} chunks - Array of chunk objects with book, startLine, content, etc.
 * @returns {Promise<void>}
 */
export async function writeNodeChunks(chunks) {
  if (!chunks || chunks.length === 0) {
    return;
  }

  const dbName = "MarkdownDB";
  const storeName = "nodes";

  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);

    openReq.onerror = () => {
      console.error('❌ Error opening database for writeNodeChunks');
      resolve();
    };

    openReq.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction([storeName], "readwrite");
      const store = tx.objectStore(storeName);

      for (const chunk of chunks) {
        // chunk must have the composite key fields (book, startLine) already on it
        store.put(chunk);
      }

      tx.oncomplete = () => {
        console.log(`✅ Wrote ${chunks.length} chunks to IndexedDB`);
        db.close();
        resolve();
      };

      tx.onerror = () => {
        console.error('❌ Error in writeNodeChunks transaction');
        db.close();
        resolve();
      };
    };
  });
}
