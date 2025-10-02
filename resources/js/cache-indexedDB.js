// In cache-indexedDB.js

import { broadcastToOpenTabs } from "./BroadcastListener.js";
import { withPending, getInitialBookSyncPromise } from "./operationState.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
import { getCurrentUser } from "./auth.js";
import { debounce } from "./divEditor.js";
import { book } from "./app.js";
import { clearRedoHistory } from "./historyManager.js";
import { getEditToolbar } from "./editToolbar.js";
import { showTick, showError } from "./editIndicator.js";

// IMPORTANT: Increment this version number ONLY when you need to change the database schema.
// For instance, if you add a new store, add a new index, or modify a keyPath.
// I've incremented it to 20 to ensure it triggers the proper migration for users on version 19.
export const DB_VERSION = 21;

/**
 * Opens (or creates) the IndexedDB database.
 * This function now implements proper schema migration using `event.oldVersion`.
 * It will preserve existing data during upgrades and only apply necessary changes.
 */
export async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MarkdownDB", DB_VERSION);

    request.onupgradeneeded = (event) => {
      console.log(`📌 IndexedDB upgrade: from version ${event.oldVersion} to ${event.newVersion}`);
      const db = event.target.result;
      const transaction = event.target.transaction; // Access the transaction for schema changes
      const oldVersion = event.oldVersion;

      // Define ALL store configurations for the FINAL desired schema at DB_VERSION 20.
      // This is the target state we are migrating to.
      const ALL_STORE_CONFIGS = [
        {
          name: "nodeChunks",
          keyPath: ["book", "startLine"],
          indices: [
            "chunk_id",
            "book",
            // Add any composite indices needed for queries, e.g., for deletion by book and line
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false }
          ],
        },

         {
          name: "footnotes",
          keyPath: ["book", "footnoteId"], // Composite key for uniqueness
          indices: ["book", "footnoteId"], // Indices for fast lookups
        },
        
        {
          name: "references",
          keyPath: ["book", "referenceId"], // Composite key for uniqueness
          indices: ["book", "referenceId"], // Indices for fast lookups
        },

        {
          name: "markdownStore",
          keyPath: ["url", "book"],
        },
        {
          name: "hyperlights",
          keyPath: ["book", "hyperlight_id"],
          indices: [
            "hyperlight_id",
            "book",
            // Add this composite index if used in your `deleteIndexedDBRecord` or `batchDeleteIndexedDBRecords`
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false }
          ],
        },
        {
          name: "hypercites",
          keyPath: ["book", "hyperciteId"],
          indices: [
            "hyperciteId",
            "book",
            // Add this composite index if used in your `deleteIndexedDBRecord` or `batchDeleteIndexedDBRecords`
            { name: "book_startLine", keyPath: ["book", "startLine"], unique: false }
          ],
        },
        {
          name: "library",
          keyPath: "book",
        },
        {
          name: "historyLog",
          keyPath: "id",
          autoIncrement: true,
          indices: ["status", "bookId"],
        },
        {
          name: "redoLog",
          keyPath: "id",
          autoIncrement: true,
          indices: ["bookId"],
        },
      ];

      

    if (oldVersion < 21) {
            console.log(
              "Migrating to schema version 21: Updating footnotes and adding references."
            );

            // Because we are changing the `keyPath` of 'footnotes', the safest
            // way is to delete the old store and create a new one.
            if (db.objectStoreNames.contains("footnotes")) {
              db.deleteObjectStore("footnotes");
              console.log("🔥 Deleted old 'footnotes' store to update schema.");
            }

            // Now, use our config to create the stores if they don't exist.
            ALL_STORE_CONFIGS.forEach((storeConfig) => {
              if (!db.objectStoreNames.contains(storeConfig.name)) {
                const storeOptions = { keyPath: storeConfig.keyPath };
                if (storeConfig.autoIncrement) {
                  storeOptions.autoIncrement = true;
                }
                const store = db.createObjectStore(
                  storeConfig.name,
                  storeOptions
                );
                console.log(`✅ Created store: ${storeConfig.name}`);

                // Create indices for the newly created store
                if (storeConfig.indices) {
                  storeConfig.indices.forEach((indexDef) => {
                    const indexName =
                      typeof indexDef === "string" ? indexDef : indexDef.name;
                    const indexKeyPath =
                      typeof indexDef === "string" ? indexDef : indexDef.keyPath;
                    const indexUnique =
                      (typeof indexDef !== "string" && indexDef.unique) || false;
                    store.createIndex(indexName, indexKeyPath, {
                      unique: indexUnique,
                    });
                    console.log(
                      `  ✅ Created index '${indexName}' for '${storeConfig.name}'`
                    );
                  });
                }
              }
            });
          }
        }; // End of onupgradeneeded

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      console.error("❌ Failed to open IndexedDB:", event.target.error);
      reject("IndexedDB Error: " + event.target.error);
    };
  });
}

export const pendingSyncs = new Map();

// MODIFIED: The "Add to List" function. This is our new trigger.
// It now accepts the full data object for updates.
export function queueForSync(store, id, type = "update", data = null, originalData = null) { // <-- ADD originalData
  const key = `${store}-${id}`;
  if (type === "update" && !data) {
    console.warn(`⚠️ queueForSync called for update on ${key} without data.`);
    return;
  }
  pendingSyncs.set(key, { store, id, type, data, originalData }); // <-- STORE originalData
  console.log(`Queued for sync: ${key} (Type: ${type})`);
  clearRedoHistory(book || "latest");
  debouncedMasterSync();
}

export function clearPendingSyncsForBook(bookId) {
  const keysToDelete = [];
  for (const [key, value] of pendingSyncs.entries()) {
    // Check if this sync is for the specified book
    if (value.data?.book === bookId) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach(key => pendingSyncs.delete(key));
  console.log(`🧹 Cleared ${keysToDelete.length} pending syncs for book: ${bookId}`);
  return keysToDelete.length;
}

export async function updateHistoryLog(logEntry) {
  const db = await openDatabase();
  const tx = db.transaction("historyLog", "readwrite");
  // .put() works for both creating and updating an entry.
  await tx.objectStore("historyLog").put(logEntry);
  return tx.done;
}

export async function executeSyncPayload(payload) {
  const bookId = payload.book;
  const promises = [];

  if (
    payload.updates.nodeChunks.length > 0 ||
    payload.deletions.nodeChunks.length > 0
  ) {
    const allNodeChunks = [
      ...payload.updates.nodeChunks.map(toPublicChunk).filter(Boolean),
      ...payload.deletions.nodeChunks,
    ];

    if (allNodeChunks.length > 0) {
      // Backend now handles multi-book requests, so send all nodeChunks together
      console.log(`📚 Syncing ${allNodeChunks.length} nodeChunks (may include multiple books)`);
      promises.push(syncNodeChunksToPostgreSQL(bookId, allNodeChunks));
    }
  }
  if (payload.updates.hypercites.length > 0) {
    promises.push(syncHyperciteToPostgreSQL(payload.updates.hypercites));
  }
  if (payload.updates.hyperlights.length > 0) {
    promises.push(syncHyperlightToPostgreSQL(payload.updates.hyperlights));
  }
  if (payload.deletions.hyperlights.length > 0) {
    promises.push(
      syncHyperlightDeletionsToPostgreSQL(payload.deletions.hyperlights)
    );
  }
  if (payload.updates.library) {
    promises.push(upsertLibraryRecord(payload.updates.library));
  }

  await Promise.all(promises);
}


async function clearRedoLog() {
  const db = await openDatabase();
  const tx = db.transaction("redoLog", "readwrite");
  await tx.objectStore("redoLog").clear();
  console.log("🧹 Redo log cleared due to new action.");
  return tx.done;
}

// In cache-indexedDB.js

export const debouncedMasterSync = debounce(async () => {
  const bookId = book || "latest";
  if (pendingSyncs.size === 0) {
    return;
  }

  console.log(`DEBOUNCED SYNC: Processing ${pendingSyncs.size} items...`);


  const initialSyncPromise = getInitialBookSyncPromise();
  if (initialSyncPromise) {
    console.log(
      "DEBOUNCED SYNC: Waiting for initial book sync to complete before proceeding...",
    );
    await initialSyncPromise;
    console.log(
      "DEBOUNCED SYNC: Initial book sync complete. Proceeding with edit sync.",
    );
  }
  
  const itemsToSync = new Map(pendingSyncs);
  pendingSyncs.clear();

  const historyLogPayload = {
    book: bookId,
    updates: { nodeChunks: [], hypercites: [], hyperlights: [], library: null },
    deletions: { nodeChunks: [], hyperlights: [], hypercites: [], library: null },
  };

  // Populate the history payload directly from the queued items
  for (const item of itemsToSync.values()) {
    if (item.type === "update") {
      // Add the new state to 'updates'
      if (item.store === "nodeChunks") {
        historyLogPayload.updates.nodeChunks.push(toPublicChunk(item.data));
      } else if (item.store === "library") {
        historyLogPayload.updates.library = item.data;
      } else {
        historyLogPayload.updates[item.store].push(item.data);
      }

      // Add the original state (if it exists) to 'deletions'
      if (item.originalData) {
        if (item.store === "nodeChunks") {
          historyLogPayload.deletions.nodeChunks.push(toPublicChunk(item.originalData));
        } else if (item.store === "library") {
          historyLogPayload.deletions.library = item.originalData;
        } else {
          historyLogPayload.deletions[item.store].push(item.originalData);
        }
      }
    } else if (item.type === "delete") {
      // Add the deleted record to 'deletions'
      if (item.data) {
        if (item.store === "nodeChunks") {
          historyLogPayload.deletions.nodeChunks.push(toPublicChunk(item.data));
        } else {
          historyLogPayload.deletions[item.store].push(item.data);
        }
      }
    }
  }

  // --- Save to Local History Log ---
  const logEntry = {
    timestamp: Date.now(),
    bookId: historyLogPayload.book,
    status: "pending",
    payload: historyLogPayload,
  };

  console.log(`DEBUG: Final historyLog payload before saving:`, JSON.stringify(historyLogPayload, null, 2));

  const db = await openDatabase();
  const tx = db.transaction("historyLog", "readwrite");
  const store = tx.objectStore("historyLog");
  const newId = await new Promise((resolve, reject) => {
    const request = store.add(logEntry);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
  logEntry.id = newId;
  await tx.done;
  console.log(`📦 Saved batch to historyLog with ID: ${logEntry.id}`);

  // --- Attempt to Sync to Backend ---
  try {
    if (!navigator.onLine) throw new Error("Offline");
    const syncPayload = {
      book: bookId,
      updates: { nodeChunks: [], hypercites: [], hyperlights: [], library: null },
      deletions: { nodeChunks: [], hyperlights: [], hypercites: [] },
    };
    for (const item of itemsToSync.values()) {
      if (item.type === "update" && item.data) {
        switch (item.store) {
          case "nodeChunks": syncPayload.updates.nodeChunks.push(item.data); break;
          case "hypercites": syncPayload.updates.hypercites.push(item.data); break;
          case "hyperlights": syncPayload.updates.hyperlights.push(item.data); break;
          case "library": syncPayload.updates.library = item.data; break;
        }
      } else if (item.type === "delete" && item.data) {
        switch (item.store) {
          case "nodeChunks": syncPayload.deletions.nodeChunks.push({ ...item.data, _action: "delete" }); break;
          case "hyperlights": syncPayload.deletions.hyperlights.push({ ...item.data, _action: "delete" }); break;
          case "hypercites": syncPayload.deletions.hypercites.push({ ...item.data, _action: "delete" }); break;
        }
      } else if (item.type === "hide" && item.data) {
        // Add hide operations to deletions but with hide action
        if (item.store === "hyperlights") {
          syncPayload.deletions.hyperlights.push({ ...item.data, _action: "hide" });
        }
      }
    }
    await executeSyncPayload(syncPayload);
    logEntry.status = "synced";
    await updateHistoryLog(logEntry);
    console.log(`✅ Batch ${logEntry.id} synced successfully.`);
    showTick(); // Show green indicator on successful server sync
  } catch (error) {
    logEntry.status = "failed";
    await updateHistoryLog(logEntry);
    console.error(`❌ Sync failed for batch ${logEntry.id}:`, error.message);
    showError(); // Show red indicator on sync failure
  } finally {
    const toolbar = getEditToolbar();
    if (toolbar) {
      await toolbar.updateHistoryButtonStates();
    }
  }
}, 3000);

// --- NEW: The "Final Save" function for page unload ---
let isSyncingOnUnload = false;
function syncOnUnload() {
  // Prevent running multiple times if both pagehide and beforeunload fire.
  if (isSyncingOnUnload || pendingSyncs.size === 0) {
    return;
  }

  isSyncingOnUnload = true;
  console.log(
    `BEACON SYNC: Page is unloading. Attempting to sync ${pendingSyncs.size} items.`
  );

  const bookId = book || "latest";
  const payload = {
    book: bookId,
    updates: {
      nodeChunks: [],
      hypercites: [],
      hyperlights: [],
      library: null,
    },
    deletions: {
      nodeChunks: [],
      hyperlights: [],
    },
  };

  // Build the payload synchronously from the data in our map
  for (const item of pendingSyncs.values()) {
    if (item.type === "update") {
      if (!item.data) continue;
      switch (item.store) {
        case "nodeChunks":
          payload.updates.nodeChunks.push(item.data);
          break;
        case "hypercites":
          payload.updates.hypercites.push(item.data);
          break;
        case "hyperlights":
          payload.updates.hyperlights.push(item.data);
          break;
        case "library":
          payload.updates.library = item.data;
          break;
      }
    } else if (item.type === "delete") {
      switch (item.store) {
        case "nodeChunks":
          payload.deletions.nodeChunks.push({
            book: bookId,
            startLine: item.id,
            _action: "delete",
          });
          break;
        case "hyperlights":
          payload.deletions.hyperlights.push({
            book: bookId,
            hyperlight_id: item.id,
          });
          break;
      }
    }
  }

  // Use navigator.sendBeacon to send the data.
  const blob = new Blob([JSON.stringify(payload)], {
    type: "application/json",
  });

  // You will need to create this new API endpoint on your server.
  const syncUrl = "/api/db/sync/beacon";
  const success = navigator.sendBeacon(syncUrl, blob);

  if (success) {
    console.log("✅ Beacon sync successfully queued.");
    pendingSyncs.clear();
  } else {
    console.error("❌ Beacon sync failed. Data may be lost.");
  }

  // This message may be shown to the user in a confirmation dialog.
  return "Your latest changes are being saved. Are you sure you want to leave?";
}

// --- NEW: Add the event listeners in your main application entry point ---
// For example, in your main app.js or an init function.
export function setupUnloadSync() {
  window.addEventListener("beforeunload", (event) => {
    if (pendingSyncs.size > 0) {
      // Cancel any pending debounced sync, as the beacon will handle it.
      debouncedMasterSync.cancel();
      const message = syncOnUnload();
      // Standard way to show a confirmation prompt.
      event.preventDefault();
      event.returnValue = message;
      return message;
    }
  });

  // `pagehide` is a more reliable event for mobile devices.
  window.addEventListener("pagehide", syncOnUnload, { capture: true });
}





// In cache-indexedDB.js, add these two functions:

/**
 * Function to sync hyperlight creations/updates to PostgreSQL.
 * @param {Array<object>} hyperlights - An array of hyperlight records.
 */
export async function syncHyperlightToPostgreSQL(hyperlights) {
  if (!hyperlights || hyperlights.length === 0) return;
  const bookId = hyperlights[0].book;

  console.log(`🔄 Syncing ${hyperlights.length} hyperlight upserts...`);
  const res = await fetch("/api/db/hyperlights/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content,
    },
    credentials: "include",
    body: JSON.stringify({
      book: bookId,
      data: hyperlights,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Hyperlight sync failed (${res.status}): ${await res.text()}`
    );
  }
  console.log("✅ Hyperlights synced");
}

/**
 * Function to sync hyperlight deletions to PostgreSQL.
 * @param {Array<object>} deletedHyperlights - Array of objects with { book, hyperlight_id }.
 */
export async function syncHyperlightDeletionsToPostgreSQL(deletedHyperlights) {
  if (!deletedHyperlights || deletedHyperlights.length === 0) return;
  const bookId = deletedHyperlights[0].book;

  // Separate hide operations from delete operations
  const deleteOperations = deletedHyperlights.filter(h => h._action === "delete");
  const hideOperations = deletedHyperlights.filter(h => h._action === "hide");

  console.log(`🔄 Syncing ${deleteOperations.length} hyperlight deletions and ${hideOperations.length} hide operations...`);

  // Process delete operations
  if (deleteOperations.length > 0) {
    const deleteRes = await fetch("/api/db/hyperlights/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN":
          document.querySelector('meta[name="csrf-token"]')?.content,
      },
      credentials: "include",
      body: JSON.stringify({
        book: bookId,
        data: deleteOperations,
      }),
    });

    if (!deleteRes.ok) {
      throw new Error(`HTTP error! status: ${deleteRes.status}`);
    }
  }

  // Process hide operations
  if (hideOperations.length > 0) {
    const hideRes = await fetch("/api/db/hyperlights/hide", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN":
          document.querySelector('meta[name="csrf-token"]')?.content,
      },
      credentials: "include",
      body: JSON.stringify({
        book: bookId,
        data: hideOperations,
      }),
    });

    if (!hideRes.ok) {
      throw new Error(`HTTP error! status: ${hideRes.status}`);
    }
  }

  console.log("✅ Hyperlight deletions and hide operations synced");
}

/**
 * Adds a new nodeChunk record to IndexedDB.
 * Can operate within an existing transaction or create its own.
 *
 * @param {string} bookId - The book identifier.
 * @param {number} startLine - The line number.
 * @param {string} content - The HTML content for the node.
 * @param {number} [chunkId=0] - The chunk ID.
 * @param {IDBTransaction} [transaction] - An optional existing transaction to use.
 * @returns {Promise<boolean>} - Success status.
 */
export async function addNewBookToIndexedDB(
  bookId,
  startLine,
  content,
  chunkId = 0,
  transaction // <-- The new optional parameter
) {
  // Your withPending wrapper is preserved.
  return withPending(async () => {
    console.log(
      `Adding nodeChunk: book=${bookId}, startLine=${startLine}, chunkId=${chunkId}`
    );

    try {
      // --- MODIFICATION START ---

      // If a transaction is NOT provided, create a new one for the 'nodeChunks' store.
      // Otherwise, use the transaction that was passed in.
      const tx =
        transaction ||
        (await openDatabase()).transaction("nodeChunks", "readwrite");

      const store = tx.objectStore("nodeChunks");
      const numericStartLine = parseNodeId(startLine);

      // ✅ Try to extract node_id from content's data-node-id attribute
      let extractedNodeId = null;
      if (content) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        const firstElement = tempDiv.firstElementChild;
        extractedNodeId = firstElement?.getAttribute('data-node-id');
      }

      const nodeChunkRecord = {
        book: bookId,
        startLine: numericStartLine,
        chunk_id: chunkId,
        node_id: extractedNodeId || null, // ✅ ADD node_id field
        content: content,
        hyperlights: [],
        hypercites: [], // Preserved your original object structure
      };

      console.log("Creating nodeChunk record:", nodeChunkRecord);
      store.put(nodeChunkRecord);

      // If we are in STANDALONE mode (we created our own transaction),
      // we are responsible for awaiting its completion.
      if (!transaction) {
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => {
            console.log(
              `✅ Successfully added nodeChunk [${bookId}, ${numericStartLine}]`
            );
            resolve(true);
          };
          tx.onerror = (e) => {
            console.error("❌ Error adding nodeChunk:", e.target.error);
            reject(e.target.error);
          };
          tx.onabort = (e) => {
            console.warn("❌ Transaction aborted:", e);
            reject(new Error("Transaction aborted"));
          };
        });
      } else {
        // If we are in SHARED mode, the caller is responsible for the transaction.
        // We just log that our part is done and resolve immediately.
        console.log(
          `✅ Queued nodeChunk [${bookId}, ${numericStartLine}] to existing transaction.`
        );
        return true; // Resolve immediately.
      }
      // --- MODIFICATION END ---
    } catch (err) {
      console.error("❌ Failed to add nodeChunk:", err);
      throw err;
    }
  });
}

export async function saveAllNodeChunksToIndexedDB(
  nodeChunks,
  bookId = "latest",
  onComplete
) {
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    nodeChunks.forEach((record) => {
      record.book = bookId;
      record.startLine = parseNodeId(record.startLine);
      store.put(record);
    });

    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ nodeChunks successfully saved for book:", bookId);
        try {
          await updateBookTimestamp(bookId);
          await syncIndexedDBtoPostgreSQL(bookId);
        } catch (err) {
          console.warn(
            "⚠️ post-save hook failed (timestamp/sync):",
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
        console.error("❌ Error saving nodeChunks to IndexedDB");
        reject();
      };
    });
  });
}

// Helper function to convert a string ID to the appropriate numeric format
export function parseNodeId(id) {
  // If already a number, return it directly
  if (typeof id === 'number') return id;
  
  // Otherwise, convert string to float (works for both "1" and "1.1")
  return parseFloat(id);
}


export function createNodeChunksKey(bookId, startLine) {

  return [bookId, parseNodeId(startLine)];
}


export async function getNodeChunksFromIndexedDB(bookId = "latest") {
  console.log("Fetching nodeChunks for book:", bookId);

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

      console.log(`✅ Retrieved ${results.length} nodeChunks for book: ${bookId}`);
      resolve(results);
    };

    request.onerror = () => {
      reject("❌ Error loading nodeChunks from IndexedDB");
    };
  });
}

/**
 * Get all node chunks for a book, sorted by startLine
 * Used for renumbering operations
 */
export async function getAllNodeChunksForBook(bookId) {
  console.log("Fetching ALL nodeChunks for renumbering, book:", bookId);

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

      console.log(`✅ Retrieved ${results.length} nodeChunks for renumbering`);
      resolve(results);
    };

    request.onerror = () => {
      console.error("❌ Error loading nodeChunks for renumbering");
      reject("❌ Error loading nodeChunks from IndexedDB");
    };
  });
}

/**
 * Renumber all nodes in IndexedDB by deleting old records and creating new ones
 * Used during system-wide renumbering operations
 */
export async function renumberNodeChunksInIndexedDB(updates, bookId) {
  console.log(`🔄 Renumbering ${updates.length} nodes in IndexedDB`);

  const db = await openDatabase();
  const tx = db.transaction("nodeChunks", "readwrite");
  const store = tx.objectStore("nodeChunks");

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




/* ---------- Footnotes Functions ---------- */

/**
 * Retrieves footnotes data for a specified book from IndexedDB.
 * 
 * The key for footnotes is now simply the book ID.
 */
export async function getFootnotesFromIndexedDB(bookId = "latest") {
  try {
    const db = await openDatabase();
    // Log the object store names to ensure "footnotes" exists.
    console.log("Database object stores:", Array.from(db.objectStoreNames));
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains("footnotes")) {
        console.warn(
          "⚠️ 'footnotes' object store is missing after initialization."
        );
        return resolve(null);
      }
      const transaction = db.transaction(["footnotes"], "readonly");
      const store = transaction.objectStore("footnotes");
      let getRequest = store.get(bookId);
      getRequest.onsuccess = () => {
        console.log(`Data retrieved for key "${bookId}":`, getRequest.result);
        resolve(getRequest.result?.data || null);
      };
      getRequest.onerror = (event) => {
        console.error(
          "❌ Error retrieving data from IndexedDB for key:",
          bookId,
          event
        );
        resolve(null);
      };
    });
  } catch (error) {
    console.error("❌ Error in getFootnotesFromIndexedDB:", error);
    return null;
  }
}


/**
 * Saves footnotes data for a specified book to IndexedDB.
 *
 * Uses the book ID as the key.
 */
export async function saveFootnotesToIndexedDB(footnotesData, bookId = "latest") {
  console.log("🙏 Attempting to save to 'footnotes' object store in IndexedDB...");

  try {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains("footnotes")) {
        console.warn("⚠️ Cannot save: 'footnotes' store missing.");
        return reject("Object store missing");
      }

      const transaction = db.transaction(["footnotes"], "readwrite");
      const store = transaction.objectStore("footnotes");

      const dataToSave = {
        book: bookId,
        data: footnotesData,
      };

      const request = store.put(dataToSave);

      // --- CORRECTED LOGIC ---
      request.onsuccess = async() => {
        console.log("✅ Successfully saved footnotes to IndexedDB.");
        // This correctly queues the library update for the debounced sync.
        await updateBookTimestamp(bookId);
        // The old, direct sync call has been removed.
        resolve();
      };
      // --- END CORRECTION ---

      request.onerror = () => {
        console.error("❌ Failed to save footnotes to IndexedDB.");
        reject("Failed to save footnotes to IndexedDB");
      };
    });
  } catch (error) {
    console.error("❌ Error opening database:", error);
    throw error;
  }
}




/**
 * Generates a localStorage key based on a provided base key and book.
 */
export function getLocalStorageKey(baseKey, bookId = "latest") {
  return `${baseKey}_${bookId}`;
}


function processNodeContentHighlightsAndCites(node, existingHypercites = []) {
  const hyperlights = [];
  const hypercites = [];
  
  console.log("Processing node:", node.outerHTML);
  
  // Create a text representation of the node to calculate positions
  const textContent = node.textContent;
  
  // Function to find the text position of an element within its parent
  function findElementPosition(element, parent) {
    // Create a TreeWalker to walk through all text nodes
    const walker = document.createTreeWalker(
      parent,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    let position = 0;
    let currentNode;
    
    // Walk through all text nodes until we find one that's inside our target element
    while ((currentNode = walker.nextNode())) {
      // If this text node is inside our target element, we've found the start
      if (element.contains(currentNode) || element === currentNode) {
        return position;
      }
      
      // Otherwise, add this text node's length to our position counter
      position += currentNode.textContent.length;
    }
    
    return -1; // Element not found
  }
  
  // Process <mark> tags for hyperlights
  const markTags = node.getElementsByTagName("mark");
  Array.from(markTags).forEach((mark) => {
    const startPos = findElementPosition(mark, node);
    const highlightLength = mark.textContent.length;
    
    if (startPos >= 0) {
      hyperlights.push({
        highlightID: mark.id,
        charStart: startPos,
        charEnd: startPos + highlightLength,
      });
      
      console.log("Calculated hyperlight positions:", {
        id: mark.id,
        text: mark.textContent,
        startPos,
        endPos: startPos + highlightLength,
        totalNodeLength: textContent.length,
      });
    }
  });
  
  // Process <u> tags for hypercites
  const uTags = node.getElementsByTagName("u");
  Array.from(uTags).forEach((uTag) => {
    // FIX: Only process <u> tags that are actual hypercites (have a specific ID format)
    // This prevents plain, non-hypercite <u> tags from being processed and causing errors.
    if (!uTag.id || !uTag.id.startsWith('hypercite_')) {
      return; // Skip this tag if it's not a valid hypercite
    }

    const startPos = findElementPosition(uTag, node);
    const uLength = uTag.textContent.length;
    
    if (startPos >= 0) {
      // ✅ MERGE: Find existing hypercite data or use defaults
      const existingHypercite = existingHypercites.find(hc => hc.hyperciteId === uTag.id);
      
      hypercites.push({
        hyperciteId: uTag.id,
        charStart: startPos,
        charEnd: startPos + uLength,
        relationshipStatus: existingHypercite?.relationshipStatus || "single",
        citedIN: existingHypercite?.citedIN || [],
        time_since: existingHypercite?.time_since || Math.floor(Date.now() / 1000)
      });
      
      console.log("Calculated hypercite positions:", {
        id: uTag.id,
        text: uTag.textContent,
        startPos,
        endPos: startPos + uLength,
        totalNodeLength: textContent.length,
      });
    }
  });
  
  // Create a clone to remove the mark and u tags
  const contentClone = node.cloneNode(true);
  
  // Remove all <mark> tags from the cloned content while preserving their text content
  const clonedMarkTags = contentClone.getElementsByTagName("mark");
  while (clonedMarkTags.length > 0) {
    const markTag = clonedMarkTags[0];
    const textContent = markTag.textContent;
    markTag.parentNode.replaceChild(document.createTextNode(textContent), markTag);
  }
  
  // Remove all <u> tags from the cloned content while preserving their text content
  const clonedUTags = contentClone.getElementsByTagName("u");
  while (clonedUTags.length > 0) {
    const uTag = clonedUTags[0];
    const textContent = uTag.textContent;
    uTag.parentNode.replaceChild(document.createTextNode(textContent), uTag);
  }
  
  const result = {
    content: contentClone.outerHTML,
    hyperlights,
    hypercites,
  };
  
  console.log("Processed result:", result);
  return result;
}


export function updateIndexedDBRecord(record) {
  return withPending(async () => {
    const bookId = book || "latest";

    // Find the nearest ancestor with a numeric ID
    let nodeId = record.id;
    let node = document.getElementById(nodeId);
    while (node && !/^\d+(\.\d+)?$/.test(nodeId)) {
      node = node.parentElement;
      if (node?.id) nodeId = node.id;
    }

    if (!/^\d+(\.\d+)?$/.test(nodeId)) {
      console.log(
        `Skipping IndexedDB update – no valid parent node ID for ${record.id}`
      );
      return;
    }

    const numericNodeId = parseNodeId(nodeId);
    console.log(
      `Updating IndexedDB record for node ${nodeId} (numeric: ${numericNodeId})`
    );

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodeChunks", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore = tx.objectStore("nodeChunks");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");
    const compositeKey = [bookId, numericNodeId];

    // Arrays to collect what we actually save for sync
    let savedNodeChunk = null;
    const savedHyperlights = [];
    const savedHypercites = [];

    // 🔥 USE YOUR EXISTING FUNCTION TO PROPERLY PROCESS THE NODE
    const processedData = node ? processNodeContentHighlightsAndCites(node) : null;

    // ✅ EXTRACT node_id from data-node-id attribute
    const nodeIdFromDOM = node ? node.getAttribute('data-node-id') : null;

    // Fetch the existing chunk record
    const getReq = chunksStore.get(compositeKey);

    getReq.onsuccess = () => {
      const existing = getReq.result;
      let toSave;

      if (existing) {
        console.log("Existing nodeChunk found for merge:", JSON.stringify(existing));

        // Start with a copy of the existing record to preserve its structure
        toSave = { ...existing };

        // 🔥 USE PROCESSED CONTENT (WITHOUT MARK/U TAGS)
        if (processedData) {
          toSave.content = processedData.content;
          // Update hyperlights and hypercites arrays in the node chunk
          toSave.hyperlights = processedData.hyperlights;
          toSave.hypercites = processedData.hypercites;
        } else {
          // Fallback to record.html if no DOM node available
          toSave.content = record.html;
        }

        // Add the chunk_ID update here
        if (record.chunk_id !== undefined) {
          toSave.chunk_id = record.chunk_id;
          console.log(`Updated chunk_id to ${record.chunk_id} for node ${nodeId}`);
        }

        // ✅ UPDATE node_id from DOM if available
        if (nodeIdFromDOM) {
          toSave.node_id = nodeIdFromDOM;
          console.log(`Updated node_id to ${nodeIdFromDOM} for node ${nodeId}`);
        }

      } else {
        // Case: No existing record, create a new one
        console.log("No existing nodeChunk record, creating new one.");
        toSave = {
          book: bookId,
          startLine: numericNodeId,
          chunk_id: record.chunk_id !== undefined ? record.chunk_id : 0,
          node_id: nodeIdFromDOM || null, // ✅ ADD node_id field
          content: processedData ? processedData.content : record.html,
          hyperlights: processedData ? processedData.hyperlights : [],
          hypercites: processedData ? processedData.hypercites : []
        };
        console.log("New nodeChunk record to create:", JSON.stringify(toSave));
      }

      console.log("Final nodeChunk record to put:", JSON.stringify(toSave));

      // Store for sync
      savedNodeChunk = toSave;

      // write the node chunk
      chunksStore.put(toSave);

      // 🔥 UPDATE INDIVIDUAL HYPERLIGHT/HYPERCITE RECORDS USING PROCESSED DATA
      if (processedData) {
        updateHyperlightRecords(processedData.hyperlights, lightsStore, bookId, numericNodeId, savedHyperlights, node);
        updateHyperciteRecords(processedData.hypercites, citesStore, bookId, savedHypercites, node);
      }
    };

    getReq.onerror = (e) => {
      console.error("Error fetching nodeChunk for update:", e.target.error);
    };

    // return a promise that resolves/rejects with the transaction
    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ IndexedDB record update complete");
        await updateBookTimestamp(bookId);

        // MODIFIED: Pass the full data object to the queue.
        if (savedNodeChunk) {
          queueForSync(
            "nodeChunks",
            savedNodeChunk.startLine,
            "update",
            savedNodeChunk
          );
        }
        savedHyperlights.forEach((hl) => {
          queueForSync("hyperlights", hl.hyperlight_id, "update", hl);
        });
        savedHypercites.forEach((hc) => {
          queueForSync("hypercites", hc.hyperciteId, "update", hc);
        });

        resolve();
      };
      tx.onerror = (e) => reject(e.target.error);
      tx.onabort = (e) => reject(new Error("Transaction aborted"));
    });
  });
}

// New batched function to replace individual updateIndexedDBRecord calls
// In cache-indexedDB.js
// In cache-indexedDB.js

export async function batchUpdateIndexedDBRecords(recordsToProcess) {
  return withPending(async () => {
    const bookId = book || "latest";
    console.log(
      `🔄 Batch updating ${recordsToProcess.length} IndexedDB records`,
    );

    const db = await openDatabase();
    const tx = db.transaction(
      ["nodeChunks", "hyperlights", "hypercites"],
      "readwrite",
    );
    const chunksStore = tx.objectStore("nodeChunks");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");

    const allSavedNodeChunks = [];
    const allSavedHyperlights = [];
    const allSavedHypercites = [];
    const originalNodeChunkStates = new Map();

    // This is a critical step: Read all original states BEFORE any writes.
    const readPromises = recordsToProcess.map((record) => {
      return new Promise((resolve) => {
        // ✅ FIX 1: Add a check for a valid record and ID before proceeding.
        if (!record || typeof record.id === "undefined" || record.id === null) {
          console.error(
            "Skipping invalid record in batch update (record or id is null/undefined):",
            record,
          );
          return resolve(); // Resolve the promise to not block the batch.
        }

        const numericNodeId = parseNodeId(record.id);

        // ✅ FIX 2: The most important check. Ensure the parsed ID is a valid number.
        if (isNaN(numericNodeId)) {
          console.error(
            `Skipping batch update for invalid node ID: '${record.id}' which parsed to NaN.`,
          );
          return resolve(); // Resolve and skip this invalid record.
        }

        const getReq = chunksStore.get([bookId, numericNodeId]);
        getReq.onsuccess = () => {
          if (getReq.result) {
            originalNodeChunkStates.set(numericNodeId, { ...getReq.result });
          }
          resolve();
        };
        getReq.onerror = (err) => {
          console.error(
            `Error getting record for batch update: ID=${record.id}`,
            err,
          );
          resolve(); // Resolve even on error to not block the whole batch.
        };
      });
    });
    await Promise.all(readPromises);

    // Now, perform the updates
    const processPromises = recordsToProcess.map(async (record) => {
      // ✅ FIX 3: Repeat the same validation here to avoid processing bad data.
      if (!record || typeof record.id === "undefined" || record.id === null) {
        return;
      }
      const numericNodeId = parseNodeId(record.id);
      if (isNaN(numericNodeId)) {
        return;
      }

      // ... (your existing logic to build `toSave` object) ...
      let nodeId = record.id;
      let node = document.getElementById(nodeId);
      while (node && !/^\d+(\.\d+)?$/.test(nodeId)) {
        node = node.parentElement;
        if (node?.id) nodeId = node.id;
      }

      if (!/^\d+(\.\d+)?$/.test(nodeId)) {
        console.log(
          `Skipping batch update – no valid parent for ${record.id}`,
        );
        return;
      }

      const finalNumericNodeId = parseNodeId(nodeId); // Use the final valid ID
      const existing = originalNodeChunkStates.get(finalNumericNodeId);
      const existingHypercites = existing?.hypercites || [];
      const processedData = node
        ? processNodeContentHighlightsAndCites(node, existingHypercites)
        : null;

      // ✅ EXTRACT node_id from data-node-id attribute
      const nodeIdFromDOM = node ? node.getAttribute('data-node-id') : null;

      // 🔍 DEBUG: Log node_id extraction
      console.log(`[node_id DEBUG] record.id=${record.id}, finalNodeId=${nodeId}, node=${node?.tagName}, nodeIdFromDOM=${nodeIdFromDOM}`);
      if (node && !nodeIdFromDOM) {
        console.warn(`⚠️ Node found but no data-node-id attribute! Element:`, node.outerHTML.substring(0, 200));
      }

      let toSave;
      if (existing) {
        toSave = { ...existing };
        if (processedData) {
          toSave.content = processedData.content;
          toSave.hyperlights = processedData.hyperlights;
          toSave.hypercites = processedData.hypercites;
        } else {
          toSave.content = record.html || existing.content;
        }
        if (record.chunk_id !== undefined)
          toSave.chunk_id = record.chunk_id;
        // ✅ UPDATE node_id from DOM if available
        if (nodeIdFromDOM) {
          toSave.node_id = nodeIdFromDOM;
        }
      } else {
        toSave = {
          book: bookId,
          startLine: finalNumericNodeId,
          chunk_id: record.chunk_id !== undefined ? record.chunk_id : 0,
          node_id: nodeIdFromDOM || null, // ✅ ADD node_id field
          content: processedData ? processedData.content : record.html || "",
          hyperlights: processedData ? processedData.hyperlights : [],
          hypercites: processedData ? processedData.hypercites : [],
        };
      }

      // 🔍 DEBUG: Log what's being saved
      console.log(`[node_id DEBUG] Saving to IndexedDB:`, { startLine: toSave.startLine, node_id: toSave.node_id, hasContent: !!toSave.content });

      chunksStore.put(toSave);
      allSavedNodeChunks.push(toSave);

      if (processedData) {
        updateHyperlightRecords(
          processedData.hyperlights,
          lightsStore,
          bookId,
          finalNumericNodeId,
          allSavedHyperlights,
          node,
        );
        updateHyperciteRecords(
          processedData.hypercites,
          citesStore,
          bookId,
          allSavedHypercites,
          node,
        );
      }
    });
    await Promise.all(processPromises);

    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        console.log("✅ Batch IndexedDB update complete");
        await updateBookTimestamp(book || "latest");

        allSavedNodeChunks.forEach((chunk) => {
          const originalChunk = originalNodeChunkStates.get(chunk.startLine);
          queueForSync(
            "nodeChunks",
            chunk.startLine,
            "update",
            chunk,
            originalChunk,
          );
        });
        allSavedHyperlights.forEach((hl) => {
          queueForSync("hyperlights", hl.hyperlight_id, "update", hl, null);
        });
        allSavedHypercites.forEach((hc) => {
          queueForSync("hypercites", hc.hyperciteId, "update", hc, null);
        });

        resolve();
      };
      tx.onerror = (e) => reject(e.target.error);
      tx.onabort = (e) => reject(new Error("Batch transaction aborted"));
    });
  });
}


export async function batchDeleteIndexedDBRecords(nodeIds) {
  return withPending(async () => {
    const bookId = book || "latest";
    
    console.log(`🗑️ Batch deleting ${nodeIds.length} IndexedDB records`);
    console.log(`🔍 First 10 IDs:`, nodeIds.slice(0, 10));
    
    try {
      const db = await openDatabase();
      console.log(`✅ Database opened successfully`);
      
      const tx = db.transaction(
        ["nodeChunks", "hyperlights", "hypercites"],
        "readwrite"
      );
      console.log(`✅ Transaction created`);
      
      const chunksStore = tx.objectStore("nodeChunks");
      const lightsStore = tx.objectStore("hyperlights");
      const citesStore = tx.objectStore("hypercites");

      // This object will collect the full data of everything we delete.
      const deletedData = {
        nodeChunks: [],
        hyperlights: [],
        hypercites: []
      };

      let processedCount = 0;
      
      // Process each node ID for deletion
      const deletePromises = nodeIds.map(async (nodeId, index) => {
        console.log(`🔍 Processing deletion ${index + 1}/${nodeIds.length}: ${nodeId}`);
        
        if (!/^\d+(\.\d+)?$/.test(nodeId)) {
          console.log(`❌ Skipping deletion – invalid node ID: ${nodeId}`);
          return;
        }

        const numericNodeId = parseNodeId(nodeId);
        const compositeKey = [bookId, numericNodeId];
        
        return new Promise((resolve, reject) => {
          const getReq = chunksStore.get(compositeKey);
          
          getReq.onsuccess = () => {
            const existing = getReq.result;
            
            if (existing) {
              console.log(`✅ Found existing record for ${nodeId}, deleting...`);
              
              // ✅ CHANGE 1: Store the original record for the history log.
              // We no longer need the `_deleted: true` flag.
              deletedData.nodeChunks.push(existing); // This is the record to ADD BACK on UNDO
              
              const deleteReq = chunksStore.delete(compositeKey);
              deleteReq.onsuccess = () => {
                processedCount++;
                console.log(`✅ Deleted ${nodeId} (${processedCount}/${nodeIds.length})`);
                resolve();
              };
              deleteReq.onerror = (e) => reject(e.target.error);
              
              try {
                const lightIndex = lightsStore.index("book_startLine");
                const lightRange = IDBKeyRange.only([bookId, numericNodeId]);
                const lightReq = lightIndex.openCursor(lightRange);
                
                lightReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    deletedData.hyperlights.push(cursor.value); // Record for undo
                    cursor.delete();
                    cursor.continue();
                  }
                };
              } catch (lightError) {
                console.warn(`⚠️ Error deleting hyperlights for ${nodeId}:`, lightError);
              }
              
              try {
                const citeIndex = citesStore.index("book_startLine");
                const citeRange = IDBKeyRange.only([bookId, numericNodeId]);
                const citeReq = citeIndex.openCursor(citeRange);
                
                citeReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    deletedData.hypercites.push(cursor.value); // Record for undo
                    cursor.delete();
                    cursor.continue();
                  }
                };
              } catch (citeError) {
                console.warn(`⚠️ Error deleting hypercites for ${nodeId}:`, citeError);
              }
            } else {
              console.log(`⚠️ No existing record found for ${nodeId}`);
              resolve();
            }
          };

          getReq.onerror = (e) => reject(e.target.error);
        });
      });

      await Promise.all(deletePromises);
      console.log(`✅ All deletion promises completed`);

      return new Promise((resolve, reject) => {
        tx.oncomplete = async () => {
          console.log(`✅ Batch IndexedDB deletion transaction complete...`);
          await updateBookTimestamp(bookId);
          
         

          // The `queueForSync` calls inside `deleteIndexedDBRecord` are for syncing to PostgreSQL,
          // not for history. They should remain for *single* deletions. For batch deletions,
          // the debouncedMasterSync will gather all the queued items.
          // Your existing queueForSync calls for deletedData are correct for PostgreSQL sync.
          deletedData.nodeChunks.forEach((record) => {
            queueForSync("nodeChunks", record.startLine, "delete", record);
          });
          deletedData.hyperlights.forEach((record) => {
            queueForSync("hyperlights", record.hyperlight_id, "delete", record);
          });
          deletedData.hypercites.forEach((record) => {
            queueForSync("hypercites", record.hyperciteId, "delete", record);
          });

          resolve();
        };
        tx.onerror = (e) => reject(e.target.error);
        tx.onabort = (e) => reject(new Error("Batch deletion transaction aborted"));
      });
    } catch (error) {
      console.error("❌ Error in batchDeleteIndexedDBRecords:", error);
      throw error;
    }
  });
}

async function upsertLibraryRecord(libraryRecord) {
  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: libraryRecord.book,
    data: libraryRecord
  };

  const res = await fetch("/api/db/library/upsert", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include", // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Library sync error:", txt);
    throw new Error(txt);
  }
  console.log("✅ Library record synced");
}

// 🔥 UPDATED: Function to update hyperlight records using processed data
function updateHyperlightRecords(hyperlights, store, bookId, numericNodeId, syncArray, node) {
  hyperlights.forEach((hyperlight) => {
    const key = [bookId, hyperlight.highlightID];
    const getRequest = store.get(key);
    
    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;
      
      // Find the actual mark element to get text content
      const markElement = node.querySelector(`#${hyperlight.highlightID}`);
      const highlightedText = markElement ? markElement.textContent : "";
      const highlightedHTML = markElement ? markElement.outerHTML : "";
      
      if (existingRecord) {
        // Update existing record with new positions
        existingRecord.startChar = hyperlight.charStart;
        existingRecord.endChar = hyperlight.charEnd;
        existingRecord.startLine = numericNodeId;
        existingRecord.highlightedText = highlightedText;
        existingRecord.highlightedHTML = highlightedHTML;
        
        store.put(existingRecord);
        syncArray.push(existingRecord);
        
        console.log(`Updated hyperlight ${hyperlight.highlightID} positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
      } else {
        // Create new record
        const newRecord = {
          book: bookId,
          hyperlight_id: hyperlight.highlightID,
          startChar: hyperlight.charStart,
          endChar: hyperlight.charEnd,
          startLine: numericNodeId,
          highlightedText: highlightedText,
          highlightedHTML: highlightedHTML,
          annotation: ""
        };
        
        store.put(newRecord);
        syncArray.push(newRecord);
        
        console.log(`Created new hyperlight ${hyperlight.highlightID} with positions: ${hyperlight.charStart}-${hyperlight.charEnd}`);
      }
    };
  });
}

// 🔥 UPDATED: Function to update hypercite records using processed data
function updateHyperciteRecords(hypercites, store, bookId, syncArray, node) {
  hypercites.forEach((hypercite) => {
    const key = [bookId, hypercite.hyperciteId];
    const getRequest = store.get(key);
    
    getRequest.onsuccess = () => {
      const existingRecord = getRequest.result;
      
      // Find the actual u element to get text content
      const uElement = node.querySelector(`#${hypercite.hyperciteId}`);
      const hypercitedText = uElement ? uElement.textContent : "";
      const hypercitedHTML = uElement ? uElement.outerHTML : "";
      
      if (existingRecord) {
        // Update existing record with new positions
        existingRecord.startChar = hypercite.charStart;
        existingRecord.endChar = hypercite.charEnd;
        existingRecord.hypercitedText = hypercitedText;
        existingRecord.hypercitedHTML = hypercitedHTML;
        
        store.put(existingRecord);
        syncArray.push(existingRecord);
        
        console.log(`Updated hypercite ${hypercite.hyperciteId} positions: ${hypercite.charStart}-${hypercite.charEnd}`);
      } else {
        // Create new record
        const newRecord = {
          book: bookId,
          hyperciteId: hypercite.hyperciteId,
          startChar: hypercite.charStart,
          endChar: hypercite.charEnd,
          hypercitedText: hypercitedText,
          hypercitedHTML: hypercitedHTML,
          citedIN: [],
          relationshipStatus: "single",
          time_since: hypercite.time_since || Math.floor(Date.now() / 1000)
        };
        
        store.put(newRecord);
        syncArray.push(newRecord);
        
        console.log(`Created new hypercite ${hypercite.hyperciteId} with positions: ${hypercite.charStart}-${hypercite.charEnd}`);
      }
    };
  });
}



// Helper function to update a specific hypercite in IndexedDB
export async function updateHyperciteInIndexedDB(book, hyperciteId, updatedFields) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "hypercites";
    
    console.log(`Updating in hypercites store: ${dbName}, key: [${book}, ${hyperciteId}]`);
    
    const request = indexedDB.open(dbName);
    
    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      resolve(false);
    };
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      
      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);
        
        // Create the composite key [book, hyperciteId]
        const key = [book, hyperciteId];
        
        // Get the record using the composite key
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const existingRecord = event.target.result;
          
          if (!existingRecord) {
            console.error(`Hypercite record not found for key: [${book}, ${hyperciteId}]`);
            resolve(false);
            return;
          }
          
          console.log("Found existing hypercite record:", existingRecord);
          
          // Update the fields in the existing record
          Object.assign(existingRecord, updatedFields);
          
          // Put the updated record back
          const updateRequest = objectStore.put(existingRecord);
          
          updateRequest.onsuccess = async() => {
            console.log(`Successfully updated hypercite for key: [${book}, ${hyperciteId}]`);
            await updateBookTimestamp(book);
            queueForSync("hypercites", hyperciteId, "update", existingRecord);
            resolve(true);
          };
          
          updateRequest.onerror = (event) => {
            console.error(`Error updating hypercite record:`, event.target.error);
            resolve(false);
          };
        };
        
        getRequest.onerror = (event) => {
          console.error(`Error getting hypercite record:`, event.target.error);
          resolve(false);
        };
        
        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("Transaction error:", error);
        resolve(false);
      }
    };
  });
}

export function toPublicChunk(chunk) {
  // Safety check
  if (!chunk || typeof chunk.content === 'undefined') {
    console.error("Attempted to create public chunk from an invalid record:", chunk);
    return null;
  }

  return {
    book:        chunk.book,
    startLine:   chunk.startLine,
    node_id:     chunk.node_id ?? null, // ✅ Include node_id for renumbering support
    content:     chunk.content,
    hyperlights: chunk.hyperlights ?? [],
    hypercites:  chunk.hypercites  ?? [],
    chunk_id:    chunk.chunk_id
  };
}



// In cache-indexedDB.js

// In cache-indexedDB.js

export function updateCitationForExistingHypercite(
  booka,
  hyperciteIDa,
  citationIDb,
) {
  return withPending(async () => {
    console.log(
      `Updating citation: book=${booka}, hyperciteID=${hyperciteIDa}, citationIDb=${citationIDb}`,
    );

    // ✅ --- NEW PRE-FLIGHT CHECK ---
    // First, ensure the hypercite exists in our local IndexedDB, fetching
    // it from the server if necessary.
    const resolvedHypercite = await resolveHypercite(booka, hyperciteIDa);

    // If it's not found anywhere (local or server), we cannot proceed.
    if (!resolvedHypercite) {
      console.error(
        `FATAL: Could not resolve hypercite ${hyperciteIDa} from any source. Aborting link.`,
      );
      // TODO: Trigger your UI prompt to the user here.
      // e.g., showHyperciteNotFoundModal(booka, hyperciteIDa);
      return { success: false, startLine: null, newStatus: null };
    }
    // ✅ --- END OF NEW LOGIC ---

    // --- YOUR EXISTING, UNCHANGED LOGIC CAN NOW SAFELY RUN ---
    // It can now be confident that any local lookups will succeed.

    let affectedStartLine = null;
    const nodeChunks = await getNodeChunksFromIndexedDB(booka);
    if (!nodeChunks?.length) {
      console.warn(`No nodeChunks found for book ${booka}`);
      return { success: false, startLine: null, newStatus: null };
    }

    let foundAndUpdated = false;
    let updatedRelationshipStatus = "single";

    // 1) Update the nodeChunks store
    for (const record of nodeChunks) {
      if (!record.hypercites?.find((hc) => hc.hyperciteId === hyperciteIDa)) {
        continue;
      }
      const startLine = record.startLine;
      const result = await addCitationToHypercite(
        booka,
        startLine,
        hyperciteIDa,
        citationIDb,
      );
      if (result.success) {
        foundAndUpdated = true;
        updatedRelationshipStatus = result.relationshipStatus;
        affectedStartLine = startLine;
        break;
      }
    }

    if (!foundAndUpdated) {
      // This block should theoretically be unreachable now, but we keep it as a safeguard.
      console.log(
        `No matching hypercite found in book ${booka} with ID ${hyperciteIDa}`,
      );
      return { success: false, startLine: null, newStatus: null };
    }

    // 2) Update the hypercites object store itself
    const existingHypercite = await getHyperciteFromIndexedDB(
      booka,
      hyperciteIDa,
    );
    if (!existingHypercite) {
      console.error(`Hypercite ${hyperciteIDa} not found in book ${booka}`);
      return { success: false, startLine: null, newStatus: null };
    }
    existingHypercite.citedIN ||= [];
    if (!existingHypercite.citedIN.includes(citationIDb)) {
      existingHypercite.citedIN.push(citationIDb);
    }
    existingHypercite.relationshipStatus = updatedRelationshipStatus;
    const hyperciteSuccess = await updateHyperciteInIndexedDB(
      booka,
      hyperciteIDa,
      {
        citedIN: existingHypercite.citedIN,
        relationshipStatus: updatedRelationshipStatus,
        hypercitedHTML: `<u id="${hyperciteIDa}" class="${updatedRelationshipStatus}">${existingHypercite.hypercitedText}</u>`,
      },
    );
    if (!hyperciteSuccess) {
      console.error(`Failed to update hypercite ${hyperciteIDa}`);
      return { success: false, startLine: null, newStatus: null };
    }

    // 3) TRY IMMEDIATE SYNC WITH FALLBACK
    try {
      const finalHyperciteRecord = await getHyperciteFromIndexedDB(
        booka,
        hyperciteIDa,
      );
      const finalNodeChunkRecord = affectedStartLine
        ? await getNodeChunkFromIndexedDB(booka, affectedStartLine)
        : null;
      if (!finalHyperciteRecord || !finalNodeChunkRecord) {
        throw new Error(
          "Could not retrieve updated records from IndexedDB for sync.",
        );
      }
      const didSyncImmediately = await syncHyperciteUpdateImmediately(
        finalHyperciteRecord,
        finalNodeChunkRecord,
      );
      if (!didSyncImmediately) {
        console.log(
          "🔄 Fallback: Queuing hypercite and nodeChunk for debounced sync.",
        );
        queueForSync(
          "nodeChunks",
          finalNodeChunkRecord.startLine,
          "update",
          finalNodeChunkRecord,
        );
        queueForSync(
          "hypercites",
          finalHyperciteRecord.hyperciteId,
          "update",
          finalHyperciteRecord,
        );
      }
    } catch (error) {
      console.error("❌ Error during sync attempt:", error);
    }

    // 4) UPDATE TIMESTAMPS FOR BOTH AFFECTED BOOKS
    const affectedBooks = new Set([booka]); // Book A (where cited text lives)

    if (citationIDb) {
      // Extract book ID from citation URL with robust parsing
      // Handle formats: /bookB#id, /bookB/HL_123#id, bookB#id
      let citationBookId = null;

      // Remove any hash fragment first to isolate the path
      const pathOnly = citationIDb.split("#")[0];
      const urlParts = pathOnly.split("/").filter(part => part); // Remove empty parts

      if (urlParts.length > 0) {
        // First non-empty part is the book ID
        // For /bookB or /bookB/HL_123, take first part
        citationBookId = urlParts[0];
        console.log(`📍 Extracted citation book ID: ${citationBookId} from ${citationIDb}`);
        affectedBooks.add(citationBookId);
      }
    }

    console.log(`📝 Updating timestamps for affected books:`, Array.from(affectedBooks));

    for (const bookId of affectedBooks) {
      await updateBookTimestamp(bookId);
      // Queue library update for sync
      const libraryRecord = await getLibraryObjectFromIndexedDB(bookId);
      if (libraryRecord) {
        queueForSync("library", bookId, "update", libraryRecord);
      }
    }

    // 🔥 CRITICAL FIX: Flush sync queue immediately (like in NewHyperciteIndexedDB)
    // This ensures timestamps are persisted before user navigates away
    console.log("⚡ Flushing sync queue immediately for hypercite link...");
    await debouncedMasterSync.flush();
    console.log("✅ Sync queue flushed.");

    // 5) RETURN SUCCESS
    return {
      success: true,
      startLine: affectedStartLine,
      newStatus: updatedRelationshipStatus,
    };
  });
}

// 🆕 Helper function to get a single nodeChunk from IndexedDB
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

// 🆕 2) Delete all nodeChunks for `book` with startLine >= afterNodeId
export async function deleteNodeChunksAfter(book, afterNodeId) {
  const numericAfter = parseNodeId(afterNodeId);
  const dbName = "MarkdownDB";
  const storeName = "nodeChunks";
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
        /*lowerOpen=*/ false,
        /*upperOpen=*/ false
      );

      const cursorReq = store.openCursor(range);
      cursorReq.onsuccess = (evt) => {
        const cur = evt.target.result;
        if (!cur) return;      // done
        store.delete(cur.primaryKey);
        cur.continue();
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

// 🆕 3) Bulk‐write an array of nodeChunk objects back into IndexedDB
//    Each object must have at least { book, startLine, chunk_id, content }
export async function writeNodeChunks(chunks) {
  if (!chunks.length) return;
  const dbName = "MarkdownDB";
  const storeName = "nodeChunks";
  return new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve();
    openReq.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction([storeName], "readwrite");
      const store = tx.objectStore(storeName);

      for (const chunk of chunks) {
        // chunk must have the inline key fields (book, startLine) already on it
        store.put(chunk);
      }

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
// 🆕 Function to sync nodeChunks to PostgreSQL
export async function syncNodeChunksToPostgreSQL(bookId, nodeChunks = []) {
  if (!nodeChunks.length) {
    console.log("ℹ️  syncNodeChunksToPostgreSQL: nothing to sync");
    return { success: true };
  }

  
  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: bookId,
    data: nodeChunks
  };

  // 🆕 DEBUG LOGGING
  console.log("🔍 DEBUG - Raw nodeChunk from IndexedDB:", JSON.stringify(nodeChunks[0], null, 2));
  console.log("🔍 DEBUG - Transformed payload:", JSON.stringify(payload, null, 2));
  console.log("🔍 DEBUG - First hypercite in payload:", JSON.stringify(payload.data[0]?.hypercites?.[0], null, 2));

  console.log(
    `🔄 Syncing ${nodeChunks.length} nodeChunks for book ${bookId}…`
  );

  const res = await fetch("/api/db/node-chunks/targeted-upsert", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "Accept":          "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include", // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ NodeChunk sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ nodeChunks synced:", out);
  return out;
}

export async function syncHyperciteToPostgreSQL(hypercites) {
  if (!hypercites || hypercites.length === 0) return { success: true };

  // All hypercites in a batch should be from the same book
  const bookId = hypercites[0].book;

  const payload = {
    book: bookId,
    data: hypercites.map(hc => ({ // Ensure each item has the correct structure
      ...hc,
      hypercitedHTML: `<u id="${hc.hyperciteId}" class="${hc.relationshipStatus}">${hc.hypercitedText}</u>`
    }))
  };

 console.log(`🔄 Syncing ${hypercites.length} hypercites…`);
  console.log('🔍 Payload being sent:', JSON.stringify(payload, null, 2));

  const res = await fetch("/api/db/hypercites/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Hypercite sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ Hypercite synced:", out);
  return out;
}

/**
 * Clears all data from all object stores in the IndexedDB.
 * This is useful for logging out or resetting the application state.
 */
export async function clearDatabase() {
  console.log("🧹 Clearing all IndexedDB data...");
  try {
    const db = await openDatabase();
    const storeNames = Array.from(db.objectStoreNames);
    
    if (storeNames.length === 0) {
      console.log(" IndexedDB is already empty.");
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
        request.onerror = (event) => {
          console.error(`  - Failed to clear store: ${name}`, event.target.error);
          reject(event.target.error);
        };
      });
    });

    await Promise.all(promises);
    console.log("✅ All IndexedDB data has been cleared.");
  } catch (error) {
    console.error("❌ Error during IndexedDB clearing:", error);
  }
}

async function addCitationToHypercite(book, startLine, hyperciteId, newCitation) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";
    
    const numericStartLine = parseNodeId(startLine);
    
    console.log(`Adding citation to hypercite in nodeChunk: book=${book}, startLine=${numericStartLine}, hyperciteId=${hyperciteId}, citation=${newCitation}`);
    
    const request = indexedDB.open(dbName);
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      
      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);
        
        const key = [book, numericStartLine];
        console.log("Using key for update:", key);
        
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const record = event.target.result;
          
          if (!record) {
            console.error(`Record not found for key: [${book}, ${numericStartLine}]`);
            resolve({ success: false });
            return;
          }
          
          console.log("Existing nodeChunk before update:", JSON.stringify(record)); // Log the full record

          // Ensure hypercites array exists and is an array
          if (!Array.isArray(record.hypercites)) {
            record.hypercites = [];
          }
          
          // Find the specific hypercite to update
          const hyperciteIndex = record.hypercites.findIndex(h => h.hyperciteId === hyperciteId);
          
          if (hyperciteIndex === -1) {
            console.error(`Hypercite ${hyperciteId} not found in nodeChunk [${book}, ${numericStartLine}]`);
            resolve({ success: false });
            return;
          }
          
          // Get a reference to the existing hypercite object within the array
          const hyperciteToUpdate = record.hypercites[hyperciteIndex];
          
          // Ensure citedIN array exists for the hypercite being updated
          if (!Array.isArray(hyperciteToUpdate.citedIN)) {
            hyperciteToUpdate.citedIN = [];
          }
          
          // Add the citation if it doesn't already exist
          if (!hyperciteToUpdate.citedIN.includes(newCitation)) {
            hyperciteToUpdate.citedIN.push(newCitation);
            console.log(`Added citation ${newCitation} to hypercite ${hyperciteId}`);
          } else {
             console.log(`Citation ${newCitation} already exists for hypercite ${hyperciteId}`);
          }
          
          // Update relationshipStatus based on citedIN length
          hyperciteToUpdate.relationshipStatus = 
            hyperciteToUpdate.citedIN.length === 1 ? "couple" : 
            hyperciteToUpdate.citedIN.length >= 2 ? "poly" : "single";

          console.log("Updated hypercite object:", JSON.stringify(hyperciteToUpdate)); // Log the updated hypercite object
          console.log("NodeChunk after modifying hypercite:", JSON.stringify(record)); // Log the full record after modification

          // Put the *entire* updated record back
          const updateRequest = objectStore.put(record);
          
          updateRequest.onsuccess = async() => {
            console.log(`✅ Successfully updated nodeChunk [${book}, ${numericStartLine}]`);
            
            // IMMEDIATE verification within the same function
            const immediateVerify = objectStore.get(key);
            immediateVerify.onsuccess = (e) => {
              const verifyRecord = e.target.result;
              const verifyHypercite = verifyRecord?.hypercites?.find(h => h.hyperciteId === hyperciteId);
              console.log('🔍 IMMEDIATE VERIFY - hypercite after put:', verifyHypercite);
              console.log('🔍 IMMEDIATE VERIFY - citedIN:', verifyHypercite?.citedIN);
            };
            
            await updateBookTimestamp(book);
            resolve({
              success: true,
              relationshipStatus: hyperciteToUpdate.relationshipStatus
            });
          };
          
          updateRequest.onerror = (event) => {
            console.error(`❌ Error updating nodeChunk record:`, event.target.error);
            resolve({ success: false });
          };
        };
        
        getRequest.onerror = (event) => {
          console.error(`❌ Error getting nodeChunk record:`, event.target.error);
          resolve({ success: false });
        };
      } catch (error) {
        console.error("❌ Transaction error:", error);
        resolve({ success: false });
      }
    };
    
    request.onerror = (event) => {
      console.error(`❌ IndexedDB error: ${event.target.errorCode}`);
      resolve({ success: false });
    };
  });
}




export async function getHyperciteFromIndexedDB(book, hyperciteId) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "hypercites";
    
    const request = indexedDB.open(dbName);
    
    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      resolve(null);
    };
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      
      try {
        const transaction = db.transaction([storeName], "readonly");
        const objectStore = transaction.objectStore(storeName);
        
        // Create the composite key [book, hyperciteId]
        const key = [book, hyperciteId];
        
        // Get the record using the composite key
        const getRequest = objectStore.get(key);
        
        getRequest.onsuccess = (event) => {
          const record = event.target.result;
          resolve(record);
        };
        
        getRequest.onerror = (event) => {
          console.error(`Error getting hypercite:`, event.target.error);
          resolve(null);
        };
        
        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("Transaction error:", error);
        resolve(null);
      }
    };
  });
} 





export async function deleteIndexedDBRecord(id) {
  return withPending(async () => {
    // Only process numeric IDs
    if (!id || !/^\d+(\.\d+)?$/.test(id)) {
      console.log(`Skipping deletion for non-numeric ID: ${id}`);
      return false;
    }

    const bookId = book || "latest";
    const numericId = parseNodeId(id);
    console.log(
      `Deleting node with ID ${id} (numeric: ${numericId}) and its associations`
    );

    const db = await openDatabase();
    // ✅ CHANGE 1: The transaction now includes all relevant stores.
    const tx = db.transaction(
      ["nodeChunks", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore = tx.objectStore("nodeChunks");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");
    const key = [bookId, numericId];

    // Collect all records to be deleted for the history log
    const deletedHistoryPayload = {
        nodeChunks: [],
        hyperlights: [],
        hypercites: []
    };

    return new Promise((resolve, reject) => {
      const getRequest = chunksStore.get(key);

      getRequest.onsuccess = () => {
        const recordToDelete = getRequest.result;

        if (recordToDelete) {
          console.log("Found record to delete:", recordToDelete);

          deletedHistoryPayload.nodeChunks.push(recordToDelete); // Add for history

          // Now, delete the main record
          chunksStore.delete(key);

          try {
            const range = IDBKeyRange.only([bookId, numericId]);

            // Delete associated hyperlights
            const lightIndex = lightsStore.index("book_startLine");
            const lightReq = lightIndex.openCursor(range);
            lightReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                console.log("Deleting associated hyperlight:", cursor.value);
                deletedHistoryPayload.hyperlights.push(cursor.value); // Add for history
                cursor.delete();
                cursor.continue();
              }
            };

            // Delete associated hypercites
            const citeIndex = citesStore.index("book_startLine");
            const citeReq = citeIndex.openCursor(range);
            citeReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                console.log("Deleting associated hypercite:", cursor.value);
                deletedHistoryPayload.hypercites.push(cursor.value); // Add for history
                cursor.delete();
                cursor.continue();
              }
            };
          } catch (error) {
            console.warn(`⚠️ Error finding associated records for node ${numericId}:`, error);
          }
        } else {
          console.log(`No record found for key: ${key}, nothing to delete.`);
        }
      };

      getRequest.onerror = (e) => reject(e.target.error);

      tx.oncomplete = async () => {
        await updateBookTimestamp(bookId);

     

        // Now, queue for sync to PostgreSQL
        // Your existing queueForSync calls for deletions are correct for backend sync.
        deletedHistoryPayload.nodeChunks.forEach((record) => {
          queueForSync("nodeChunks", record.startLine, "delete", record);
        });
        deletedHistoryPayload.hyperlights.forEach((record) => {
          queueForSync("hyperlights", record.hyperlight_id, "delete", record);
        });
        deletedHistoryPayload.hypercites.forEach((record) => {
          queueForSync("hypercites", record.hyperciteId, "delete", record);
        });

        const toolbar = getEditToolbar();
        if (toolbar) {
            await toolbar.updateHistoryButtonStates();
        }

        resolve(true);
      };

      tx.onerror = (e) => reject(e.target.error);
    });
  });
}


/**
 * Renames a record's primary key in IndexedDB by creating a new record
 * and deleting the old one. This is essential for "normalization" tasks,
 * such as renumbering node `startLine` IDs after numerous edits have
 * created fractional or non-sequential keys.
 *
 * @param {string|number} oldId - The original startLine of the record.
 * @param {string|number} newId - The new startLine for the record.
 * @param {string} html - The new HTML content for the record.
 */
export async function updateIndexedDBRecordForNormalization(
  oldId, newId, html
) {
  return withPending(async () => {
    console.log(`Normalizing record in IndexedDB: ${oldId} -> ${newId}`);

    // Only numeric IDs allowed
    const numericOldId = parseNodeId(oldId);
    const numericNewId = parseNodeId(newId);
    const bookId = book || "latest";

    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");

    // Optional timeout/abort
    const TRANSACTION_TIMEOUT = 15_000;
    const timeoutId = setTimeout(() => tx.abort(), TRANSACTION_TIMEOUT);

    // Kick off the get/put/delete sequence
    const oldKey = [bookId, numericOldId];
    const getOld = store.get(oldKey);

    getOld.onsuccess = () => {
      const oldRecord = getOld.result;
      if (oldRecord) console.log("Found old record:", oldRecord);

      // Build new record
      const newRecord = oldRecord
        ? { ...oldRecord,
            book: bookId,
            startLine: numericNewId,
            content: html || oldRecord.content }
        : { book: bookId,
            startLine: numericNewId,
            chunk_id: 0,
            content: html,
            hyperlights: [],
            hypercites: [] };

      const newKey = [bookId, numericNewId];
      const putReq = store.put(newRecord);

      putReq.onerror = (e) => {
        console.error("Error adding new record:", e.target.error);
        // Let the tx.onerror handler reject
      };

      // If we had an old record, delete it
      if (oldRecord) {
        const delReq = store.delete(oldKey);
        delReq.onerror = (e) => {
          console.error("Error deleting old record:", e.target.error);
        };
      }
    };

    getOld.onerror = (e) => {
      console.error("Error getting old record:", e.target.error);
      // Let the tx.onerror handler reject
    };

    // Now wait for the transaction to finish
    return new Promise((resolve, reject) => {
      tx.oncomplete = async () => {
        clearTimeout(timeoutId);
        await updateBookTimestamp(bookId);
        // MODIFIED: This direct sync call is now handled by the queue.
        // We need to queue the deletion of the old and update of the new.
        const newRecord = await getNodeChunkFromIndexedDB(bookId, newId);
        if (newRecord) {
          queueForSync("nodeChunks", newId, "update", newRecord);
        }
        queueForSync("nodeChunks", oldId, "delete");
        resolve(true);
      };
      tx.onerror = (e) => {
        clearTimeout(timeoutId);
        console.error("Transaction error during normalization:", e.target.error);
        reject(e.target.error);
      };
      tx.onabort = (e) => {
        clearTimeout(timeoutId);
        console.warn("Transaction aborted:", e);
        reject(new Error("Transaction aborted"));
      };
    });
  });
}


// Generic retry function for IndexedDB operations
export async function retryOperation(operation, maxRetries = 3, delay = 1000) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.warn(`Operation failed (attempt ${attempt}/${maxRetries}):`, error);
      lastError = error;
      
      if (attempt < maxRetries) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
        // Increase delay for next attempt (exponential backoff)
        delay *= 1.5;
      }
    }
  }
  
  // If we get here, all retries failed
  console.error(`Operation failed after ${maxRetries} attempts:`, lastError);
  throw lastError;
}

// Example usage with the delete function
export async function deleteIndexedDBRecordWithRetry(id) {
  return retryOperation(() => deleteIndexedDBRecord(id));
}





/**
 * Updates the timestamp for a book in the library object store to the current time.
 * Call this after successful IndexedDB operations to track when the book was last modified.
 * 
 * @param {string} bookId - The book identifier (defaults to current book)
 * @returns {Promise<boolean>} - Success status
 */
// Corrected version:
export async function updateBookTimestamp(bookId = book || "latest") {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const getRequest = store.get(bookId);

    return new Promise((resolve, reject) => {
      getRequest.onerror = (e) => {
        console.error("❌ Failed to get library record for timestamp update:", e.target.error);
        reject(e.target.error);
      };

      getRequest.onsuccess = () => {
        // ✅ STEP 1: Capture the original state BEFORE any modifications.
        // `structuredClone` creates a true, deep copy.
        const originalRecord = getRequest.result ? structuredClone(getRequest.result) : null;
        let recordToSave;

        if (getRequest.result) {
          // Now it's safe to modify the record we fetched.
          recordToSave = getRequest.result;
          recordToSave.timestamp = Date.now();
        } else {
          // If it's a new record, the original state is correctly `null`.
          recordToSave = {
            book: bookId,
            timestamp: Date.now(),
            title: bookId,
            description: "",
            tags: [],
          };
        }

        const putRequest = store.put(recordToSave);

        putRequest.onerror = (e) => {
          console.error("❌ Failed to put updated library record:", e.target.error);
          reject(e.target.error);
        };

        putRequest.onsuccess = () => {
          // ✅ STEP 2: Queue for sync, providing BOTH the new and original data.
          queueForSync("library", bookId, "update", recordToSave, originalRecord);
          resolve(true);
        };
      };
    });
  } catch (error) {
    console.error("❌ Failed to update book timestamp:", error);
    return false;
  }
}


// Helper function to get library object from IndexedDB
export async function getLibraryObjectFromIndexedDB(book) {
  try {
    // ✅ Validate the book parameter first
    if (!book) {
      console.warn("⚠️ No book ID provided to getLibraryObjectFromIndexedDB");
      return null;
    }

    if (typeof book !== 'string' && typeof book !== 'number') {
      console.warn("⚠️ Invalid book ID type:", typeof book, book);
      return null;
    }

    console.log("🔍 Looking up library object for book:", book);

    const db = await openDatabase();
    const tx = db.transaction(["library"], "readonly");
    const libraryStore = tx.objectStore("library");
    
    const getRequest = libraryStore.get(book);
    
    const libraryObject = await new Promise((resolve, reject) => {
      getRequest.onsuccess = (e) => {
        const result = e.target.result;
        console.log("📚 IndexedDB lookup result for book:", book, result ? "found" : "not found");
        resolve(result);
      };
      getRequest.onerror = (e) => {
        console.error("❌ IndexedDB get request failed:", e.target.error);
        reject(e.target.error);
      };
    });

    if (libraryObject) {
      console.log("📚 Retrieved library object for book:", book, libraryObject);
    } else {
      console.log("📚 No library object found for book:", book);
    }
    
    return libraryObject;
    
  } catch (error) {
    console.error("❌ Error getting library object from IndexedDB:", error);
    console.error("❌ Book parameter was:", book, typeof book);
    return null;
  }
}

// In cache-indexedDB.js

/**
 * TRIES to immediately sync a hypercite and its parent nodeChunk.
 * Returns `true` on success and `false` on failure, allowing for a fallback.
 * @param {object} updatedHypercite - The full hypercite object to sync.
 * @param {object} updatedNodeChunk - The full nodeChunk object that contains the hypercite.
 * @returns {Promise<boolean>} - A promise that resolves to true if sync was successful, false otherwise.
 */
export async function syncHyperciteUpdateImmediately(
  updatedHypercite,
  updatedNodeChunk,
) {
  // 1. Quick check for offline status
  if (!navigator.onLine) {
    console.log(
      "🔌 Browser is offline. Skipping immediate sync, will fallback to queue.",
    );
    return false;
  }

  console.log(
    "⚡ Attempting IMMEDIATE sync for hypercite:",
    updatedHypercite.hyperciteId,
  );
  try {
    const syncPromises = [];

    // Promise for syncing the hypercite
    if (updatedHypercite) {
      const hypercitePayload = {
        book: updatedHypercite.book,
        data: [updatedHypercite],
      };
      syncPromises.push(
        fetch("/api/db/hypercites/upsert", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": document
              .querySelector('meta[name="csrf-token"]')
              ?.getAttribute("content"),
          },
          credentials: "include",
          body: JSON.stringify(hypercitePayload),
        }).then((res) => {
          if (!res.ok) {
            // Throw an error to be caught by the outer catch block
            throw new Error(
              `Immediate hypercite sync failed with status: ${res.status}`,
            );
          }
          console.log("✅ Immediate hypercite sync successful.");
          return res.json();
        }),
      );
    }

    // Promise for syncing the nodeChunk
    if (updatedNodeChunk) {
      const nodeChunkPayload = {
        book: updatedNodeChunk.book,
        data: [toPublicChunk(updatedNodeChunk)],
      };
      syncPromises.push(
        fetch("/api/db/node-chunks/targeted-upsert", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": document
              .querySelector('meta[name="csrf-token"]')
              ?.getAttribute("content"),
          },
          credentials: "include",
          body: JSON.stringify(nodeChunkPayload),
        }).then((res) => {
          if (!res.ok) {
            throw new Error(
              `Immediate nodeChunk sync failed with status: ${res.status}`,
            );
          }
          console.log("✅ Immediate nodeChunk sync successful.");
          return res.json();
        }),
      );
    }

    await Promise.all(syncPromises);
    console.log("⚡ Immediate sync transaction complete.");
    return true; // Return true on success
  } catch (error) {
    console.error("❌ Immediate sync failed, will fallback to queue.", error);
    return false; // Return false on any failure
  }
}

// In cache-indexedDB.js

/**
 * Resolves a hypercite by first checking the local IndexedDB, and if not found,
 * fetching it from the server. Caches the server result locally for future lookups.
 * @param {string} bookId - The book identifier for the hypercite.
 * @param {string} hyperciteId - The ID of the hypercite to find.
 * @returns {Promise<object|null>} - The hypercite object if found, otherwise null.
 */
async function resolveHypercite(bookId, hyperciteId) {
  // Path 1: Check local IndexedDB first. (Unchanged)
  const localHypercite = await getHyperciteFromIndexedDB(bookId, hyperciteId);
  if (localHypercite) {
    console.log("✅ Resolved hypercite from local IndexedDB.");
    return localHypercite;
  }

  // Path 2: If not found locally, check the server.
  console.log(
    "🤔 Hypercite not in local DB. Fetching hypercite and its entire parent book...",
  );
  try {
    const response = await fetch(
      `/api/db/hypercites/find/${bookId}/${hyperciteId}`,
      { /* ... your fetch options ... */ }
    );

    if (!response.ok) {
      // ... error handling is unchanged ...
      return null;
    }

    const data = await response.json();
    const serverHypercite = data.hypercite;
    const serverNodeChunks = data.nodeChunks; // Note the plural

    if (!serverHypercite || !serverNodeChunks || serverNodeChunks.length === 0) {
        console.error("❌ Server response was missing hypercite or nodeChunks data.");
        return null;
    }

    console.log(`✅ Resolved hypercite and ${serverNodeChunks.length} nodeChunks from server. Caching all...`);

    // ✅ CACHE BOTH THE HYPERCITE AND ALL THE NODECHUNKS
    const db = await openDatabase();
    const tx = db.transaction(["hypercites", "nodeChunks"], "readwrite");
    const hypercitesStore = tx.objectStore("hypercites");
    const nodeChunksStore = tx.objectStore("nodeChunks");

    // Put the single hypercite record
    hypercitesStore.put(serverHypercite);

    // Bulk-write all the node chunks
    for (const chunk of serverNodeChunks) {
        nodeChunksStore.put(chunk);
    }

    await tx.done;
    console.log("✅ Successfully cached all records in IndexedDB.");

    // Return just the hypercite, as the calling function expects.
    return serverHypercite;

  } catch (error) {
    console.error("❌ Network error while fetching hypercite and book content:", error);
    return null;
  }
}


// In cache-indexedDB.js

/**
 * Saves an array of footnote objects to IndexedDB and then syncs to PostgreSQL.
 * @param {Array<object>} footnotes - The array of footnote objects from your JSON.
 * @param {string} bookId - The ID of the book they belong to.
 */
export async function saveAllFootnotesToIndexedDB(footnotes, bookId) {
  if (!footnotes || footnotes.length === 0) return;
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("footnotes", "readwrite");
    const store = tx.objectStore("footnotes");

    footnotes.forEach((footnote) => {
      const record = { ...footnote, book: bookId };
      store.put(record);
    });

    return new Promise((resolve, reject) => {
      // Make the oncomplete handler async to use await
      tx.oncomplete = async () => {
        console.log(
          `✅ ${footnotes.length} footnotes successfully saved to IndexedDB for book: ${bookId}`
        );

        // --- ADDED: Trigger the sync to PostgreSQL ---
        try {
          await syncFootnotesToPostgreSQL(bookId, footnotes);
        } catch (err) {
          // Log the error but don't reject the promise, as the local save was successful.
          console.warn("⚠️ Footnote sync to PostgreSQL failed:", err);
        }
        // --- END ADDED ---

        resolve();
      };
      tx.onerror = (e) => {
        console.error("❌ Error saving footnotes to IndexedDB:", e.target.error);
        reject(e.target.error);
      };
    });
  });
}

/**
 * Saves an array of reference objects to IndexedDB and then syncs to PostgreSQL.
 * @param {Array<object>} references - The array of reference objects from your JSON.
 * @param {string} bookId - The ID of the book they belong to.
 */
export async function saveAllReferencesToIndexedDB(references, bookId) {
  if (!references || references.length === 0) return;
  return withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("references", "readwrite");
    const store = tx.objectStore("references");

    references.forEach((reference) => {
      const record = { ...reference, book: bookId };
      store.put(record);
    });

    return new Promise((resolve, reject) => {
      // Make the oncomplete handler async to use await
      tx.oncomplete = async () => {
        console.log(
          `✅ ${references.length} references successfully saved to IndexedDB for book: ${bookId}`
        );

        // --- ADDED: Trigger the sync to PostgreSQL ---
        try {
          await syncReferencesToPostgreSQL(bookId, references);
        } catch (err) {
          console.warn("⚠️ Reference sync to PostgreSQL failed:", err);
        }
        // --- END ADDED ---

        resolve();
      };
      tx.onerror = (e) => {
        console.error("❌ Error saving references to IndexedDB:", e.target.error);
        reject(e.target.error);
      };
    });
  });
}


/**
 * Syncs a batch of footnotes to PostgreSQL via the API.
 * @param {string} bookId - The ID of the book.
 * @param {Array<object>} footnotes - The array of footnote objects.
 */
async function syncFootnotesToPostgreSQL(bookId, footnotes) {
  if (!footnotes || footnotes.length === 0) return;

  console.log(`🔄 Syncing ${footnotes.length} footnotes to PostgreSQL...`);
  const payload = { book: bookId, data: footnotes };

  try {
    const res = await fetch("/api/db/footnotes/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN":
          document.querySelector('meta[name="csrf-token"]')?.content,
      },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(
        `Footnote sync failed (${res.status}): ${await res.text()}`
      );
    }
    console.log("✅ Footnotes synced to PostgreSQL.");
  } catch (error) {
    console.error("❌ Error syncing footnotes to PostgreSQL:", error);
    // In a production app, you might queue this for a later retry.
  }
}

/**
 * Syncs a batch of references to PostgreSQL via the API.
 * @param {string} bookId - The ID of the book.
 * @param {Array<object>} references - The array of reference objects.
 */
async function syncReferencesToPostgreSQL(bookId, references) {
  if (!references || references.length === 0) return;

  console.log(`🔄 Syncing ${references.length} references to PostgreSQL...`);
  const payload = { book: bookId, data: references };

  try {
    const res = await fetch("/api/db/references/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN":
          document.querySelector('meta[name="csrf-token"]')?.content,
      },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(
        `Reference sync failed (${res.status}): ${await res.text()}`
      );
    }
    console.log("✅ References synced to PostgreSQL.");
  } catch (error) {
    console.error("❌ Error syncing references to PostgreSQL:", error);
  }
}
