/**
 * Master Sync Module
 * Handles the main synchronization logic from IndexedDB to PostgreSQL
 */

import { openDatabase } from '../core/connection';
import { debounce } from '../../utilities/debounce.js';
import { toPublicChunk } from '../core/utilities';
import { pendingSyncs } from './queue';
import { refreshCsrfToken } from '../../utilities/auth.js';
// Pure helper extracted so the cross-book filter + fallback can be unit-tested
// in isolation. Tests: tests/javascript/indexedDB/master.test.js
import { filterFreshNodesForBook } from './freshNodeFilter';

export { filterFreshNodesForBook };

import type {
  BookId,
  HistoryLogEntry,
  LibraryRecord,
  NodeRecord,
  PublicChunk,
  SyncQueueItem,
  SyncRecordData,
} from '../types';

interface MasterSyncDeps {
  book: BookId | null | undefined;
  getInitialBookSyncPromise: () => Promise<unknown> | null;
  glowCloudGreen?: (opts?: unknown) => void;
  glowCloudRed?: (opts?: unknown) => void;
  glowCloudLocalSave?: () => void;
}

/** The updates/deletions payload executeSyncPayload flattens onto the wire. */
export interface SyncPayloadInput {
  book: BookId;
  updates: {
    nodes: Array<NodeRecord | PublicChunk>;
    hypercites?: SyncRecordData[];
    hyperlights?: SyncRecordData[];
    footnotes?: SyncRecordData[];
    bibliography?: SyncRecordData[];
    library?: SyncRecordData | null;
  };
  deletions: {
    nodes: SyncRecordData[];
    hyperlights?: SyncRecordData[];
    hypercites?: SyncRecordData[];
    footnotes?: SyncRecordData[];
    bibliography?: SyncRecordData[];
  };
}

// Dependencies that will be injected
let book: MasterSyncDeps['book'];
let getInitialBookSyncPromise: MasterSyncDeps['getInitialBookSyncPromise'];
let glowCloudGreen: MasterSyncDeps['glowCloudGreen'];
let glowCloudRed: MasterSyncDeps['glowCloudRed'];
let glowCloudLocalSave: MasterSyncDeps['glowCloudLocalSave'];

// Per-book count of CONSECUTIVE 5xx sync failures. A single 5xx usually succeeds on retry
// (→ transient toast), but a persistent run means the backend is genuinely down (→ the
// serious blackBox/report modal). Reset on any success or non-5xx outcome.
const _serverErrorStreak = new Map<BookId, number>();
const SERVER_ERROR_MODAL_THRESHOLD = 2;

// Initialization function to inject dependencies
export function initMasterSyncDependencies(deps: MasterSyncDeps): void {
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
export async function updateHistoryLog(logEntry: HistoryLogEntry): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction("historyLog", "readwrite");
  // .put() works for both creating and updating an entry.
  await tx.objectStore("historyLog").put(logEntry);
  return new Promise<void>((resolve, reject) => {
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
async function getFailedBatchesForBook(bookId: BookId): Promise<HistoryLogEntry[]> {
  try {
    const db = await openDatabase();
    const tx = db.transaction("historyLog", "readonly");
    const store = tx.objectStore("historyLog");
    const index = store.index("status");

    const failedLogs = await new Promise<HistoryLogEntry[]>((resolve, reject) => {
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
 * Execute a sync payload by sending it to the unified sync API
 *
 * @param {Object} payload - Sync payload with updates and deletions
 * @returns {Promise<Object>} API response
 */
export async function executeSyncPayload(payload: SyncPayloadInput): Promise<Record<string, unknown>> {
  const bookId = payload.book;

  // Prepare node chunks (combine updates and deletions)
  const allNodeChunks: SyncRecordData[] = [
    ...payload.updates.nodes.map(toPublicChunk).filter((c): c is PublicChunk => Boolean(c)),
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
    footnoteDeletions: payload.deletions.footnotes || [],
    bibliography: payload.updates.bibliography || [],
    bibliographyDeletions: payload.deletions.bibliography || [],
    library: payload.updates.library || null,
  };

  // Log what we're syncing
  const syncSummary = [];
  if (allNodeChunks.length > 0) syncSummary.push(`${allNodeChunks.length} node chunks`);
  if (unifiedPayload.hypercites.length > 0) syncSummary.push(`${unifiedPayload.hypercites.length} hypercites`);
  if (unifiedPayload.hyperlights.length > 0) syncSummary.push(`${unifiedPayload.hyperlights.length} hyperlights`);
  if (unifiedPayload.hyperlightDeletions.length > 0) syncSummary.push(`${unifiedPayload.hyperlightDeletions.length} hyperlight deletions`);
  if (unifiedPayload.footnotes.length > 0) syncSummary.push(`${unifiedPayload.footnotes.length} footnotes`);
  if (unifiedPayload.footnoteDeletions.length > 0) syncSummary.push(`${unifiedPayload.footnoteDeletions.length} footnote deletions`);
  if (unifiedPayload.bibliography.length > 0) syncSummary.push(`${unifiedPayload.bibliography.length} bibliography entries`);
  if (unifiedPayload.bibliographyDeletions.length > 0) syncSummary.push(`${unifiedPayload.bibliographyDeletions.length} bibliography deletions`);
  if (unifiedPayload.library) syncSummary.push('library record');

  console.log(`🔄 Unified sync: ${syncSummary.join(', ')}`);

  // Helper: perform the fetch with a fresh CSRF token from the meta tag
  const doFetch = () => fetch("/api/db/unified-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content
    } as HeadersInit,
    credentials: "include",
    body: JSON.stringify(unifiedPayload)
  });

  let res = await doFetch();

  // Handle expired CSRF token (419) — refresh and retry once
  if (res.status === 419) {
    console.warn("🔄 Got 419 (CSRF token expired), refreshing token and retrying...");
    try {
      const stillAuthenticated = await refreshCsrfToken();
      if (!stillAuthenticated) {
        throw new Error("Session expired — please log in again and refresh the page. Your changes are saved locally.");
      }
      res = await doFetch();
    } catch (refreshError) {
      console.error("❌ Failed to refresh CSRF token:", refreshError);
      throw refreshError;
    }
  }

  if (!res.ok) {
    // Handle stale data (409 Conflict) specially
    if (res.status === 409) {
      const errorData = await res.json();
      if (errorData.error === 'STALE_DATA') {
        console.error("📵 Stale data detected - your book is out of date");
        // Clear pending syncs so a manual refresh won't re-trigger the same stale sync
        pendingSyncs.clear();
        // Hard-block via the same overlay used for cross-tab edits — this is the same
        // "you're stale, reload" situation, just detected cross-device (BroadcastChannel
        // can't see other devices, so the server's 409 is the only signal). Blocking is
        // warranted because we have an unsynced edit that can't be reconciled automatically.
        //
        // NOTE (future): reloading DISCARDS the user's just-rejected edit. A smarter version
        // could diff the local edit against the server's newer version and auto-merge when
        // they don't overlap, only blocking on a true conflict — so we only throw work away
        // when we absolutely have to. (Mirror of the note in BroadcastListener.showStaleTabOverlay.)
        import('../../utilities/BroadcastListener.js')
          .then(({ showStaleTabOverlay }) => showStaleTabOverlay(
            "This book was edited elsewhere (another device or window). Refresh to load the latest version — your last change wasn't saved."
          ))
          .catch(() => { /* overlay module unavailable — the thrown error still glows red */ });
        // Throw a specific error so callers can identify stale data issues. classifySyncError
        // returns null for STALE_DATA, so glowCloudRed won't also show a toast over the overlay.
        const staleError = new Error(errorData.message || 'Book is out of date') as Error & {
          code?: string; status?: number; serverTimestamp?: unknown;
        };
        staleError.code = 'STALE_DATA';
        staleError.status = 409;
        staleError.serverTimestamp = errorData.server_timestamp;
        throw staleError;
      }
    }

    const txt = await res.text();
    console.error("❌ Unified sync error:", txt);
    // Attach the HTTP status so the save-error classifier can tell 5xx/4xx apart.
    const syncError = new Error(`Unified sync failed: ${txt}`) as Error & { status?: number };
    syncError.status = res.status;
    throw syncError;
  }

  const result = await res.json();
  console.log("✅ Unified sync completed:", result);
  return result;
}

/**
 * Process sync for a single book's items
 * Handles history logging, failed batch merging, and server sync
 */
async function syncItemsForBook(bookId: BookId, bookItems: Map<string, SyncQueueItem>): Promise<void> {
  console.log(`DEBOUNCED SYNC: Processing ${bookItems.size} items for book: ${bookId}...`);

  const historyLogPayload: HistoryLogEntry['payload'] = {
    book: bookId,
    updates: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], bibliography: [], library: null },
    deletions: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], bibliography: [], library: null },
  };

  // Populate the history payload directly from the queued items
  for (const item of bookItems.values()) {
    if (item.type === "update") {
      // Add the new state to 'updates'
      if (item.store === "nodes") {
        historyLogPayload.updates.nodes.push(toPublicChunk(item.data as NodeRecord | null)!);
      } else if (item.store === "library") {
        historyLogPayload.updates.library = item.data as LibraryRecord | null;
      } else {
        (historyLogPayload.updates[item.store] as unknown[]).push(item.data);
      }

      // Add the original state (if it exists) to 'deletions'
      if (item.originalData) {
        if (item.store === "nodes") {
          historyLogPayload.deletions.nodes.push(toPublicChunk(item.originalData as NodeRecord | null)!);
        } else if (item.store === "library") {
          historyLogPayload.deletions.library = item.originalData as LibraryRecord | null;
        } else {
          (historyLogPayload.deletions[item.store] as unknown[]).push(item.originalData);
        }
      }
    } else if (item.type === "delete") {
      // Add the deleted record to 'deletions'
      if (item.data) {
        if (item.store === "nodes") {
          historyLogPayload.deletions.nodes.push(toPublicChunk(item.data as NodeRecord | null)!);
        } else {
          (historyLogPayload.deletions[item.store] as unknown[]).push(item.data);
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

  let logEntry: HistoryLogEntry | null = null;

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
    const newId = await new Promise<IDBValidKey>((resolve, reject) => {
      const request = store.add(logEntry);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    logEntry.id = newId as number;
    await new Promise<void>((resolve, reject) => {
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
    const syncPayload: {
      book: BookId;
      updates: {
        nodes: NodeRecord[]; hypercites: SyncRecordData[]; hyperlights: SyncRecordData[];
        footnotes: SyncRecordData[]; bibliography: SyncRecordData[]; library: SyncRecordData | null;
      };
      deletions: {
        nodes: Array<SyncRecordData & { _action?: 'delete' | 'hide' }>;
        hyperlights: Array<SyncRecordData & { _action?: 'delete' | 'hide' }>;
        hypercites: Array<SyncRecordData & { _action?: 'delete' | 'hide' }>;
        footnotes: Array<SyncRecordData & { _action?: 'delete' | 'hide' }>;
        bibliography: Array<SyncRecordData & { _action?: 'delete' | 'hide' }>;
      };
    } = {
      book: bookId,
      updates: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], bibliography: [], library: null },
      deletions: { nodes: [], hyperlights: [], hypercites: [], footnotes: [], bibliography: [] },
    };
    for (const item of bookItems.values()) {
      if (item.type === "update" && item.data) {
        switch (item.store) {
          case "nodes": syncPayload.updates.nodes.push(item.data as NodeRecord); break;
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
          case "footnotes": syncPayload.deletions.footnotes.push({ ...item.data, _action: "delete" }); break;
          case "bibliography": syncPayload.deletions.bibliography.push({ ...item.data, _action: "delete" }); break;
        }
      } else if (item.type === "hide" && item.data) {
        // Add hide operations to deletions but with hide action
        if (item.store === "hyperlights") {
          syncPayload.deletions.hyperlights.push({ ...item.data, _action: "hide" });
        }
      }
    }

    // --- Re-read library record from IndexedDB to ensure fresh data ---
    // Mirrors the node re-read pattern: prevents stale queued data
    // (e.g. visibility changes from privacy toggle) from overwriting
    // the correct state on the backend.
    if (syncPayload.updates.library) {
      try {
        const db = await openDatabase();
        const tx = db.transaction("library", "readonly");
        const store = tx.objectStore("library");
        const freshLibrary = await new Promise<LibraryRecord | undefined>((resolve, reject) => {
          const req = store.get(bookId);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (freshLibrary) {
          syncPayload.updates.library = freshLibrary;
          console.log(`🔄 Re-read library record fresh from IndexedDB for sync`);
        }
      } catch (libError) {
        console.warn("Failed to re-read library from IndexedDB, using queued data:", libError);
      }
    }

    // --- Re-read ALL nodes from IndexedDB to ensure fresh data ---
    // This prevents stale data issues where queue references become outdated
    let failedBatches: HistoryLogEntry[] = [];
    try {
      failedBatches = await getFailedBatchesForBook(bookId);

      // Collect ALL node_ids that need to be synced (from current sync AND failed batches)
      const allNodeIdsToSync = new Set<string>();
      const deletionNodeIds = new Set<string>();
      const deletionsToRecover: Array<SyncRecordData & { node_id?: string | null }> = [];

      // Add node_ids from current sync
      for (const node of syncPayload.updates.nodes) {
        if (node.node_id) allNodeIdsToSync.add(node.node_id);
      }
      for (const node of syncPayload.deletions.nodes as Array<{ node_id?: string | null }>) {
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
        const { getNodesByDataNodeIDs } = await import('../hydration/rebuild');
        const freshNodes = await getNodesByDataNodeIDs([...allNodeIdsToSync]);

        // Only substitute fresh data when it belongs to the correct book.
        // getNodesByDataNodeIDs may return a different book's record (alphabetically first)
        // when the same node_id exists across books (sub-book nodes share a node_id
        // prefix with the parent book because setElementIds uses the global `book`).
        syncPayload.updates.nodes = filterFreshNodesForBook(
          freshNodes,
          syncPayload.updates.nodes,
          bookId,
        );
        const matchedCount = freshNodes.filter(n => n.book === bookId).length;
        console.log(`🔄 Re-read ${freshNodes.length} node(s) fresh from IndexedDB for sync (${matchedCount} matched book ${bookId})`);
      }

      // Add deletions (verify node still doesn't exist in IndexedDB)
      if (deletionsToRecover.length > 0) {
        const { getNodesByDataNodeIDs } = await import('../hydration/rebuild');
        const existCheck = await getNodesByDataNodeIDs(deletionsToRecover.map(n => n.node_id!));
        // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
        // node when the same node_id exists in both parent and sub-book.
        const stillExistIds = new Set(existCheck.filter(n => n.book === bookId).map(n => n.node_id));
        for (const node of deletionsToRecover) {
          if (!stillExistIds.has(node.node_id!)) {
            syncPayload.deletions.nodes.push({ ...node, _action: "delete" });
          }
        }
      }
    } catch (mergeError) {
      console.error("Failed to merge/refresh nodes for sync (proceeding with current sync):", mergeError);
      failedBatches = []; // Reset so we don't incorrectly mark them synced
    }

    await executeSyncPayload(syncPayload);
    _serverErrorStreak.delete(bookId); // success → reset the 5xx streak for this book
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
      console.error(`❌ Sync failed for batch ${logEntry.id}:`, (error as Error).message);
    } else {
      console.error(`❌ Non-node sync failed:`, (error as Error).message);
    }
    // Tiered server-error handling. A 5xx means the SERVER failed (our fault), but the edit
    // is saved locally and will retry:
    //   - first 5xx        → transient toast naming the code (usually recovers on retry)
    //   - persistent 5xx   → the serious blackBox/report modal (backend genuinely down)
    // Non-5xx errors reset the streak and fall through to the normal classified toast.
    const status = (error as { status?: number }).status;
    const is5xx = typeof status === 'number' && status >= 500;

    if (is5xx) {
      const streak = (_serverErrorStreak.get(bookId) || 0) + 1;
      _serverErrorStreak.set(bookId, streak);

      if (streak >= SERVER_ERROR_MODAL_THRESHOLD) {
        _serverErrorStreak.delete(bookId); // reset so it takes another run to re-fire
        if (glowCloudRed) glowCloudRed();   // glow only — the modal carries the message
        import('../../integrity/reporter.js')
          .then(({ reportServerError }) => reportServerError({ bookId, status, error: error as Error }))
          .catch(() => { /* reporter unavailable — glow still conveys the error */ });
        return;
      }
      // First failure of the run → transient toast naming the code.
      if (glowCloudRed) glowCloudRed({ error, status, savedLocally: !!logEntry });
      return;
    }

    // Non-5xx: reset any prior 5xx run, then glow + explain via the classifier.
    _serverErrorStreak.delete(bookId);
    if (glowCloudRed) {
      glowCloudRed({ error, status, code: (error as { code?: string }).code, savedLocally: !!logEntry });
    }
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
    const bookId = item?.data?.book;
    if (syntheticBooks.includes(bookId as string) || bookId?.endsWith('/timemachine')) {
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

  // Group items by book so each sub-book syncs independently
  const itemsByBook = new Map<BookId, Map<string, SyncQueueItem>>();
  const mainContent = document.querySelector('.main-content');
  const fallbackBookId = mainContent?.id || book || "latest";

  for (const [key, item] of itemsToSync) {
    const itemBook = item.data?.book || fallbackBookId;
    if (!itemsByBook.has(itemBook)) {
      itemsByBook.set(itemBook, new Map());
    }
    itemsByBook.get(itemBook)!.set(key, item);
  }

  // Sync each book's items separately
  for (const [bookId, bookItems] of itemsByBook) {
    await syncItemsForBook(bookId, bookItems);
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
export async function syncIndexedDBtoPostgreSQLBlocking(bookId: BookId): Promise<Record<string, unknown>> {
  console.log("🔄 Starting BLOCKING full sync to PostgreSQL for book:", bookId);

  try {
    const db = await openDatabase();

    // Get all data from IndexedDB
    const nodesTx = db.transaction("nodes", "readonly");
    const nodesStore = nodesTx.objectStore("nodes");
    const nodesIndex = nodesStore.index("book");
    const nodesRequest = nodesIndex.getAll(bookId);

    const nodes = await new Promise<NodeRecord[]>((resolve, reject) => {
      nodesRequest.onsuccess = () => resolve(nodesRequest.result || []);
      nodesRequest.onerror = () => reject(nodesRequest.error);
    });

    // Prepare payload
    const payload = {
      book: bookId,
      updates: {
        nodes: nodes.map(toPublicChunk).filter((c): c is PublicChunk => Boolean(c)),
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
