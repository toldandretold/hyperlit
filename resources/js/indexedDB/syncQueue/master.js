/**
 * Master Sync Module
 * Handles the main synchronization logic from IndexedDB to PostgreSQL
 */

import { openDatabase } from '../core/connection.js';
import { debounce } from '../../utilities/debounce.js';
import { toPublicChunk } from '../core/utilities.js';
import { pendingSyncs } from './queue.js';

// Dependencies that will be injected
let book, getInitialBookSyncPromise, glowCloudGreen, glowCloudRed, glowCloudLocalSave;

// Initialization function to inject dependencies
export function initMasterSyncDependencies(deps) {
  book = deps.book;
  getInitialBookSyncPromise = deps.getInitialBookSyncPromise;
  glowCloudGreen = deps.glowCloudGreen;
  glowCloudRed = deps.glowCloudRed;
  glowCloudLocalSave = deps.glowCloudLocalSave;
}

/**
 * Update a history log entry in IndexedDB
 *
 * @param {Object} logEntry - History log entry to update
 * @returns {Promise<void>}
 */
export async function updateHistoryLog(logEntry) {
  const db = await openDatabase();
  const tx = db.transaction("historyLog", "readwrite");
  // .put() works for both creating and updating an entry.
  await tx.objectStore("historyLog").put(logEntry);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get all failed history log entries for a specific book.
 * Used to merge failed batch data into the next sync attempt.
 *
 * @param {string} bookId - Book identifier
 * @returns {Promise<Array>} Array of failed log entries (empty on error)
 */
async function getFailedBatchesForBook(bookId) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("historyLog", "readonly");
    const store = tx.objectStore("historyLog");
    const index = store.index("status");

    const failedLogs = await new Promise((resolve, reject) => {
      const request = index.getAll("failed");
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    return failedLogs.filter(log => log.bookId === bookId);
  } catch (error) {
    console.error("Error fetching failed batches:", error);
    return [];
  }
}

/**
 * Create a genesis history entry for a new book.
 * This marks the initial state that undo cannot go past.
 *
 * @param {string} bookId - Book identifier
 * @param {Array} initialNodes - Array of initial node chunks
 * @returns {Promise<void>}
 */
export async function createGenesisHistoryEntry(bookId, initialNodes = []) {
  const db = await openDatabase();
  const tx = db.transaction("historyLog", "readwrite");
  const store = tx.objectStore("historyLog");

  const genesisEntry = {
    timestamp: Date.now(),
    bookId: bookId,
    status: "genesis",
    isGenesis: true,
    payload: {
      book: bookId,
      updates: { nodes: initialNodes, hypercites: [], hyperlights: [], footnotes: [], library: null },
      deletions: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], library: null }
    }
  };

  await new Promise((resolve, reject) => {
    const request = store.add(genesisEntry);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  console.log(`🌱 Created genesis history entry for book: ${bookId}`);
}

/**
 * Execute a sync payload by sending it to the unified sync API
 *
 * @param {Object} payload - Sync payload with updates and deletions
 * @returns {Promise<Object>} API response
 */
export async function executeSyncPayload(payload) {
  const bookId = payload.book;

  // Prepare node chunks (combine updates and deletions)
  const allNodeChunks = [
    ...payload.updates.nodes.map(toPublicChunk).filter(Boolean),
    ...payload.deletions.nodes,
  ];

  // Prepare the unified sync request payload
  const unifiedPayload = {
    book: bookId,
    nodes: allNodeChunks,
    hypercites: payload.updates.hypercites || [],
    hyperlights: payload.updates.hyperlights || [],
    hyperlightDeletions: payload.deletions.hyperlights || [],
    footnotes: payload.updates.footnotes || [],
    bibliography: payload.updates.bibliography || [],
    library: payload.updates.library || null,
  };

  // Log what we're syncing
  const syncSummary = [];
  if (allNodeChunks.length > 0) syncSummary.push(`${allNodeChunks.length} node chunks`);
  if (unifiedPayload.hypercites.length > 0) syncSummary.push(`${unifiedPayload.hypercites.length} hypercites`);
  if (unifiedPayload.hyperlights.length > 0) syncSummary.push(`${unifiedPayload.hyperlights.length} hyperlights`);
  if (unifiedPayload.hyperlightDeletions.length > 0) syncSummary.push(`${unifiedPayload.hyperlightDeletions.length} hyperlight deletions`);
  if (unifiedPayload.footnotes.length > 0) syncSummary.push(`${unifiedPayload.footnotes.length} footnotes`);
  if (unifiedPayload.bibliography.length > 0) syncSummary.push(`${unifiedPayload.bibliography.length} bibliography entries`);
  if (unifiedPayload.library) syncSummary.push('library record');

  console.log(`🔄 Unified sync: ${syncSummary.join(', ')}`);

  // Make single unified API request
  const res = await fetch("/api/db/unified-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include",
    body: JSON.stringify(unifiedPayload)
  });

  if (!res.ok) {
    // Handle stale data (409 Conflict) specially
    if (res.status === 409) {
      const errorData = await res.json();
      if (errorData.error === 'STALE_DATA') {
        console.error("📵 Stale data detected - your book is out of date");
        // Clear pending syncs so a manual refresh won't re-trigger the same stale sync
        pendingSyncs.clear();
        alert('Your book is out of date. Please refresh to get the latest version.\n\nYour recent changes could not be saved because another device has made edits since you last loaded this page.');
        // Throw a specific error so callers can identify stale data issues
        const staleError = new Error(errorData.message || 'Book is out of date');
        staleError.code = 'STALE_DATA';
        staleError.serverTimestamp = errorData.server_timestamp;
        throw staleError;
      }
    }

    const txt = await res.text();
    console.error("❌ Unified sync error:", txt);
    throw new Error(`Unified sync failed: ${txt}`);
  }

  const result = await res.json();
  console.log("✅ Unified sync completed:", result);
  return result;
}

/**
 * Process sync for a single book's items
 * Handles history logging, failed batch merging, and server sync
 */
async function syncItemsForBook(bookId, bookItems) {
  console.log(`DEBOUNCED SYNC: Processing ${bookItems.size} items for book: ${bookId}...`);

  const historyLogPayload = {
    book: bookId,
    updates: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], bibliography: [], library: null },
    deletions: { nodes: [], hyperlights: [], hypercites: [], bibliography: [], library: null },
  };

  // Populate the history payload directly from the queued items
  for (const item of bookItems.values()) {
    if (item.type === "update") {
      // Add the new state to 'updates'
      if (item.store === "nodes") {
        historyLogPayload.updates.nodes.push(toPublicChunk(item.data));
      } else if (item.store === "library") {
        historyLogPayload.updates.library = item.data;
      } else {
        historyLogPayload.updates[item.store].push(item.data);
      }

      // Add the original state (if it exists) to 'deletions'
      if (item.originalData) {
        if (item.store === "nodes") {
          historyLogPayload.deletions.nodes.push(toPublicChunk(item.originalData));
        } else if (item.store === "library") {
          historyLogPayload.deletions.library = item.originalData;
        } else {
          historyLogPayload.deletions[item.store].push(item.originalData);
        }
      }
    } else if (item.type === "delete") {
      // Add the deleted record to 'deletions'
      if (item.data) {
        if (item.store === "nodes") {
          historyLogPayload.deletions.nodes.push(toPublicChunk(item.data));
        } else {
          historyLogPayload.deletions[item.store].push(item.data);
        }
      }
    }
  }

  // --- Save to Local History Log (ONLY for node changes) ---
  // History log is ONLY for nodes - footnotes, hyperlights, hypercites are separate
  // Footnote content is stored in nodes anyway
  const hasNodeChanges =
    historyLogPayload.updates.nodes.length > 0 ||
    historyLogPayload.deletions.nodes.length > 0;

  let logEntry = null;

  if (hasNodeChanges) {
    logEntry = {
      timestamp: Date.now(),
      bookId: historyLogPayload.book,
      status: "pending",
      payload: historyLogPayload,
    };

    const db = await openDatabase();
    const tx = db.transaction("historyLog", "readwrite");
    const store = tx.objectStore("historyLog");
    const newId = await new Promise((resolve, reject) => {
      const request = store.add(logEntry);
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
    logEntry.id = newId;
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    console.log(`📦 Saved batch to historyLog with ID: ${logEntry.id}`);
  } else {
    console.log(`📝 Skipping history log - no node changes (library/hyperlights/hypercites only)`);
  }

  // --- Handle Offline Mode ---
  if (!navigator.onLine) {
    if (logEntry) {
      console.log(`📡 Offline: batch ${logEntry.id} saved locally, will sync when online`);
    } else {
      console.log(`📡 Offline: non-node changes not saved (no history entry needed)`);
    }
    // Keep status as "pending" - will be retried by retryFailedBatches when online
    if (glowCloudLocalSave) glowCloudLocalSave();
    return; // Exit early - data is safe in historyLog (if it was node changes)
  }

  // --- Attempt to Sync to Backend ---
  try {
    const syncPayload = {
      book: bookId,
      updates: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], bibliography: [], library: null },
      deletions: { nodes: [], hyperlights: [], hypercites: [], bibliography: [] },
    };
    for (const item of bookItems.values()) {
      if (item.type === "update" && item.data) {
        switch (item.store) {
          case "nodes": syncPayload.updates.nodes.push(item.data); break;
          case "hypercites": syncPayload.updates.hypercites.push(item.data); break;
          case "hyperlights": syncPayload.updates.hyperlights.push(item.data); break;
          case "footnotes": syncPayload.updates.footnotes.push(item.data); break;
          case "bibliography": syncPayload.updates.bibliography.push(item.data); break;
          case "library": syncPayload.updates.library = item.data; break;
        }
      } else if (item.type === "delete" && item.data) {
        switch (item.store) {
          case "nodes": syncPayload.deletions.nodes.push({ ...item.data, _action: "delete" }); break;
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

    // --- Re-read ALL nodes from IndexedDB to ensure fresh data ---
    // This prevents stale data issues where queue references become outdated
    let failedBatches = [];
    try {
      failedBatches = await getFailedBatchesForBook(bookId);

      // Collect ALL node_ids that need to be synced (from current sync AND failed batches)
      const allNodeIdsToSync = new Set();
      const deletionNodeIds = new Set();
      const deletionsToRecover = [];

      // Add node_ids from current sync
      for (const node of syncPayload.updates.nodes) {
        if (node.node_id) allNodeIdsToSync.add(node.node_id);
      }
      for (const node of syncPayload.deletions.nodes) {
        if (node.node_id) deletionNodeIds.add(node.node_id);
      }

      // Add node_ids from failed batches
      if (failedBatches.length > 0) {
        console.log(`🔄 Found ${failedBatches.length} failed batch(es) to merge into current sync`);

        for (const batch of failedBatches) {
          const payload = batch.payload;
          if (!payload) continue;

          // Add all updated node_ids from failed batches
          for (const node of (payload.updates?.nodes || [])) {
            if (node.node_id) allNodeIdsToSync.add(node.node_id);
          }

          // Collect true deletions (in deletions but NOT in updates for this batch)
          const batchUpdatedIds = new Set(
            (payload.updates?.nodes || []).map(n => n.node_id).filter(Boolean)
          );
          for (const node of (payload.deletions?.nodes || [])) {
            if (node.node_id && !batchUpdatedIds.has(node.node_id) && !deletionNodeIds.has(node.node_id)) {
              deletionsToRecover.push(node);
              deletionNodeIds.add(node.node_id);
            }
          }
        }
      }

      // Re-read ALL nodes fresh from IndexedDB (prevents stale queue references)
      if (allNodeIdsToSync.size > 0) {
        const { getNodesByUUIDs } = await import('../hydration/rebuild.js');
        const freshNodes = await getNodesByUUIDs([...allNodeIdsToSync]);

        // Replace sync payload nodes with fresh data
        syncPayload.updates.nodes = freshNodes;
        console.log(`🔄 Re-read ${freshNodes.length} node(s) fresh from IndexedDB for sync`);
      }

      // Add deletions (verify node still doesn't exist in IndexedDB)
      if (deletionsToRecover.length > 0) {
        const { getNodesByUUIDs } = await import('../hydration/rebuild.js');
        const existCheck = await getNodesByUUIDs(deletionsToRecover.map(n => n.node_id));
        const stillExistIds = new Set(existCheck.map(n => n.node_id));
        for (const node of deletionsToRecover) {
          if (!stillExistIds.has(node.node_id)) {
            syncPayload.deletions.nodes.push({ ...node, _action: "delete" });
          }
        }
      }
    } catch (mergeError) {
      console.error("Failed to merge/refresh nodes for sync (proceeding with current sync):", mergeError);
      failedBatches = []; // Reset so we don't incorrectly mark them synced
    }

    await executeSyncPayload(syncPayload);
    if (logEntry) {
      logEntry.status = "synced";
      await updateHistoryLog(logEntry);
      console.log(`✅ Batch ${logEntry.id} synced successfully.`);
    } else {
      console.log(`✅ Non-node sync completed (no history entry).`);
    }

    // Mark merged failed batches as synced
    for (const failedBatch of failedBatches) {
      try {
        failedBatch.status = "synced";
        await updateHistoryLog(failedBatch);
        console.log(`✅ Previously failed batch ${failedBatch.id} now marked as synced`);
      } catch (markError) {
        console.error(`Failed to mark batch ${failedBatch.id} as synced:`, markError);
      }
    }

    if (glowCloudGreen) glowCloudGreen(); // Glow cloud green on successful server sync
  } catch (error) {
    if (logEntry) {
      logEntry.status = "failed";
      await updateHistoryLog(logEntry);
      console.error(`❌ Sync failed for batch ${logEntry.id}:`, error.message);
    } else {
      console.error(`❌ Non-node sync failed:`, error.message);
    }
    if (glowCloudRed) glowCloudRed(); // Glow cloud red on sync failure
  }
}

/**
 * Main debounced sync function
 * Processes all pending syncs and sends them to PostgreSQL
 * Waits 3 seconds after last change before syncing
 */
export const debouncedMasterSync = debounce(async () => {
  if (pendingSyncs.size === 0) {
    return;
  }

  // Determine book ID from queued data, skipping synthetic homepage books
  const syntheticBooks = ['most-recent', 'most-connected', 'most-lit'];

  // Filter out synthetic book items that can't be synced
  for (const [key, item] of pendingSyncs) {
    if (syntheticBooks.includes(item?.data?.book)) {
      pendingSyncs.delete(key);
    }
  }

  if (pendingSyncs.size === 0) {
    console.log(`[SYNC] All pending items were for synthetic books, nothing to sync`);
    return;
  }

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

  // Determine the book ID from queued data
  const mainContent = document.querySelector('.main-content');
  let syncBookId = null;
  for (const item of itemsToSync.values()) {
    const itemBook = item.data?.book;
    if (itemBook && !syntheticBooks.includes(itemBook)) {
      syncBookId = itemBook;
      break;
    }
  }
  if (!syncBookId) {
    syncBookId = mainContent?.id || book || "latest";
  }

  await syncItemsForBook(syncBookId, itemsToSync);

  // ✅ Dynamically import toolbar (only exists when editing)
  try {
    const { getEditToolbar } = await import('../../editToolbar/index.js');
    const toolbar = getEditToolbar();
    if (toolbar) {
      await toolbar.updateHistoryButtonStates();
    }
  } catch (e) {
    // Toolbar not loaded (not in edit mode)
  }
}, 3000);

/**
 * Sync all IndexedDB data to PostgreSQL for a specific book (BLOCKING)
 *
 * ⚠️ WARNING: This is a BLOCKING sync implementation created during refactor.
 * It reimplements sync logic instead of using the proven postgreSQL.js functions.
 *
 * WHEN TO USE:
 * - ✅ Critical operations requiring immediate sync confirmation
 * - ✅ Full book exports or snapshots
 *
 * WHEN NOT TO USE:
 * - ❌ Background/automatic syncing (use postgreSQL.js:syncIndexedDBtoPostgreSQL() instead)
 * - ❌ Edit operations (already handled by debouncedMasterSync)
 * - ❌ Import operations (use non-blocking sync)
 *
 * DIFFERENCE FROM postgreSQL.js:syncIndexedDBtoPostgreSQL():
 * - This version: Waits for sync to complete, uses unified endpoint
 * - Original version: Returns immediately, uses individual endpoints (proven stable)
 *
 * @param {string} bookId - Book identifier
 * @returns {Promise<Object>} Sync result
 */
export async function syncIndexedDBtoPostgreSQLBlocking(bookId) {
  console.log("🔄 Starting BLOCKING full sync to PostgreSQL for book:", bookId);

  try {
    const db = await openDatabase();

    // Get all data from IndexedDB
    const nodesTx = db.transaction("nodes", "readonly");
    const nodesStore = nodesTx.objectStore("nodes");
    const nodesIndex = nodesStore.index("book");
    const nodesRequest = nodesIndex.getAll(bookId);

    const nodes = await new Promise((resolve, reject) => {
      nodesRequest.onsuccess = () => resolve(nodesRequest.result || []);
      nodesRequest.onerror = () => reject(nodesRequest.error);
    });

    // Prepare payload
    const payload = {
      book: bookId,
      updates: {
        nodes: nodes.map(toPublicChunk).filter(Boolean),
        hypercites: [],
        hyperlights: [],
        library: null
      },
      deletions: {
        nodes: [],
        hyperlights: [],
        hypercites: []
      }
    };

    // Execute sync
    const result = await executeSyncPayload(payload);
    console.log("✅ Full sync completed for book:", bookId);
    return result;

  } catch (error) {
    console.error("❌ Full sync failed:", error);
    throw error;
  }
}
