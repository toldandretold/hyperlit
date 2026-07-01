/**
 * Master Sync Module
 * Handles the main synchronization logic from IndexedDB to PostgreSQL
 */

import { openDatabase } from '../core/connection';
import { debounce } from '../../utilities/debounce';
import { toPublicNode } from '../core/utilities';
import { pendingSyncs } from './queue';
import { refreshCsrfToken } from '../../utilities/auth/index';
// Pure helper extracted so the cross-book filter + fallback can be unit-tested
// in isolation. Tests: tests/javascript/indexedDB/master.test.js
import { filterFreshNodesForBook } from './freshNodeFilter';
// Per-book sync serialization, extracted for unit testing (tests/javascript/indexedDB/bookSyncChain.test.js)
import { runSerializedPerKey } from './bookSyncChain';
import { advanceBaseTimestamp } from '../core/library';
import { asBookId } from '../types';

export { filterFreshNodesForBook };

import type {
  BookId,
  HistoryLogEntry,
  LibraryRecord,
  FootnoteRecord,
  BibliographyRecord,
  HyperciteRecord,
  HyperlightRecord,
  NodeRecord,
  PublicNode,
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
  /** Optimistic-concurrency token — the server version this client last knew. The server
   *  409s if its current timestamp is newer than this. See LibraryRecord.base_timestamp. */
  base_timestamp?: number;
  updates: {
    nodes: Array<NodeRecord | PublicNode>;
    hypercites?: HyperciteRecord[];
    hyperlights?: HyperlightRecord[];
    footnotes?: FootnoteRecord[];
    bibliography?: BibliographyRecord[];
    library?: LibraryRecord | null;
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

// Serialize unified syncs per book. The debounce does NOT await its async body, so a second
// drain can run syncItemsForBook for the same book while the first is still awaiting the network.
// Both would then read base_timestamp before either advances it, and the first to land ratchets
// the server clock past the other's stale base → a false "Book out of date" 409. Chaining each
// book's sync onto the previous guarantees a drain reads base_timestamp only AFTER the prior
// drain wrote it. Keyed by book so different books (and sub-books) still sync in parallel.
const _bookSyncChain = new Map<BookId, Promise<unknown>>();

// Highest server_timestamp this client has been ACKed for, per book (session-scoped).
// Lets a 409 STALE_DATA distinguish a SELF-conflict — the server's current timestamp is one
// WE ourselves produced, our sync's base merely lagged behind a rapid prior sync — from a real
// cross-device conflict (a timestamp we've NEVER seen, > this high-water, could only come from
// another device). Self-conflicts are recovered silently (fast-forward base + retry once);
// unknown/higher timestamps still hard-block, so a genuine remote edit is never clobbered.
const _ackedServerTs = new Map<BookId, number>();

/** Record a server-acknowledged timestamp for a book (monotonic high-water). */
function recordAckedServerTs(bookId: BookId, ts: unknown): void {
  if (typeof ts === 'number' && ts > 0) {
    _ackedServerTs.set(bookId, Math.max(_ackedServerTs.get(bookId) ?? 0, ts));
  }
}

// Abort a unified-sync POST that never responds, so a hung request can't park the per-book
// chain above. An abort surfaces as a normal sync failure: the node batch is parked in
// historyLog ('failed') and re-sent on the next sync attempt (getFailedBatchesForBook), and
// retried on next online/boot. Nothing is lost — edits are already in IndexedDB.
const SYNC_TIMEOUT_MS = 30000;

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
/** The exact JSON body POSTed to /api/db/unified-sync — the IDB→PG wire contract. */
interface UnifiedSyncPayload {
  book: BookId;
  /** Node UPDATES are PublicNode (the wire shape); node DELETIONS carry `_action` and
   *  stay SyncRecordData. The union keeps the update path typed without forcing deletions. */
  nodes: Array<PublicNode | SyncRecordData>;
  hypercites: HyperciteRecord[];
  hyperlights: HyperlightRecord[];
  hyperlightDeletions: SyncRecordData[];
  footnotes: FootnoteRecord[];
  footnoteDeletions: SyncRecordData[];
  bibliography: BibliographyRecord[];
  bibliographyDeletions: SyncRecordData[];
  library: LibraryRecord | null;
  /** Optimistic-concurrency token the server checks against (see SyncPayloadInput). */
  base_timestamp?: number;
}

export async function executeSyncPayload(payload: SyncPayloadInput): Promise<Record<string, unknown>> {
  const bookId = payload.book;

  // Prepare nodes: updates → PublicNode (wire shape), deletions stay as-is.
  const allNodes: Array<PublicNode | SyncRecordData> = [
    ...payload.updates.nodes.map(toPublicNode).filter((c): c is PublicNode => Boolean(c)),
    ...payload.deletions.nodes,
  ];

  // A brand-new book isn't settled on the server yet (marked by `pending_new_book_sync`). Applying
  // the optimistic-concurrency stale check to it is premature: several sync paths (bulk-create, the
  // edit-exit full-book sync, the title auto-sync) bump the server's library.timestamp while the
  // client base lags, so the debounced unified-sync races behind and 409s — hard-blocking a user
  // editing a book they just made. Send a FALSY base so the server (`&& $base`, UnifiedSyncController
  // :107) SKIPS the check for the not-yet-settled book. The server reads both `base_timestamp` AND
  // `library.timestamp` (:104), so we null BOTH on the wire — never mutating the IDB record. Success
  // still returns `server_timestamp`, which advances the base, so the FIRST post-settle sync has a
  // correct base; the flag is cleared once creation truly settles (createNewBook.fireAndForgetSync).
  let isPendingNewBook = false;
  try {
    const pending = JSON.parse(sessionStorage.getItem('pending_new_book_sync') || 'null');
    isPendingNewBook = !!pending && pending.bookId === bookId;
  } catch { /* malformed flag — treat as not pending */ }

  const wireLibrary: any = payload.updates.library || null;
  const finalLibrary = (isPendingNewBook && wireLibrary) ? { ...wireLibrary, timestamp: undefined } : wireLibrary;

  // Prepare the unified sync request payload (typed to the wire contract).
  const unifiedPayload: UnifiedSyncPayload = {
    book: bookId,
    nodes: allNodes,
    hypercites: payload.updates.hypercites || [],
    hyperlights: payload.updates.hyperlights || [],
    hyperlightDeletions: payload.deletions.hyperlights || [],
    footnotes: payload.updates.footnotes || [],
    footnoteDeletions: payload.deletions.footnotes || [],
    bibliography: payload.updates.bibliography || [],
    bibliographyDeletions: payload.deletions.bibliography || [],
    library: finalLibrary,
    // The concurrency token. Prefer the explicit value the caller computed (live sync re-reads
    // it fresh from IDB; replay carries the queue-time base); fall back to the library record's
    // own base_timestamp, then its timestamp (brand-new book never pulled → no base yet). For a
    // pending (not-yet-settled) new book, force it undefined so the server skips the stale check.
    base_timestamp: isPendingNewBook
      ? undefined
      : (payload.base_timestamp
        ?? payload.updates.library?.base_timestamp
        ?? payload.updates.library?.timestamp),
  };

  // Log what we're syncing
  const syncSummary = [];
  if (allNodes.length > 0) syncSummary.push(`${allNodes.length} nodes`);
  if (unifiedPayload.hypercites.length > 0) syncSummary.push(`${unifiedPayload.hypercites.length} hypercites`);
  if (unifiedPayload.hyperlights.length > 0) syncSummary.push(`${unifiedPayload.hyperlights.length} hyperlights`);
  if (unifiedPayload.hyperlightDeletions.length > 0) syncSummary.push(`${unifiedPayload.hyperlightDeletions.length} hyperlight deletions`);
  if (unifiedPayload.footnotes.length > 0) syncSummary.push(`${unifiedPayload.footnotes.length} footnotes`);
  if (unifiedPayload.footnoteDeletions.length > 0) syncSummary.push(`${unifiedPayload.footnoteDeletions.length} footnote deletions`);
  if (unifiedPayload.bibliography.length > 0) syncSummary.push(`${unifiedPayload.bibliography.length} bibliography entries`);
  if (unifiedPayload.bibliographyDeletions.length > 0) syncSummary.push(`${unifiedPayload.bibliographyDeletions.length} bibliography deletions`);
  if (unifiedPayload.library) syncSummary.push('library record');

  console.log(`🔄 Unified sync: ${syncSummary.join(', ')}`);

  // Helper: perform the fetch with a fresh CSRF token + a per-call abort timeout (so a hung
  // POST can't stall the per-book chain). The controller/timer are per call because doFetch
  // may run twice (419 retry).
  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    try {
      return await fetch("/api/db/unified-sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-CSRF-TOKEN": document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content
        } as HeadersInit,
        credentials: "include",
        body: JSON.stringify(unifiedPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await doFetch();
  let staleRetried = false; // guards the one-shot self-conflict retry below

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
      let errorData = await res.json();
      if (errorData.error === 'STALE_DATA') {
        // ── Self-conflict recovery ──────────────────────────────────────────────
        // If the server's current timestamp is one THIS client has ALREADY been ACKed for,
        // the "stale" version is our OWN prior sync (a rapid earlier save advanced the server
        // past this sync's lagging base) — NOT another device. Fast-forward our base to it and
        // retry once, silently, instead of hard-blocking the user. A server_timestamp we've
        // NEVER seen (> our high-water, or none recorded) could come from another device — that
        // still blocks below, so a genuine remote edit is never clobbered.
        const conflictTs = (errorData as { server_timestamp?: unknown }).server_timestamp;
        const acked = _ackedServerTs.get(bookId);
        if (!staleRetried && typeof conflictTs === 'number' && acked != null && conflictTs <= acked) {
          staleRetried = true;
          console.warn(`🔁 STALE_DATA self-conflict for ${bookId}: fast-forwarding base ${unifiedPayload.base_timestamp} → ${conflictTs}, retrying once.`);
          unifiedPayload.base_timestamp = conflictTs;
          await advanceBaseTimestamp(bookId, conflictTs); // persist so the next drain reads the fixed base
          res = await doFetch();
          if (res.ok) {
            const retryResult = await res.json();
            console.log("✅ Unified sync completed after self-conflict retry:", retryResult);
            recordAckedServerTs(bookId, (retryResult as { server_timestamp?: unknown }).server_timestamp);
            return retryResult;
          }
          // Retry still failed — re-read the body and fall through to the right error path.
          if (res.status === 409) {
            try { errorData = await res.json(); } catch { errorData = {}; }
            if (errorData.error !== 'STALE_DATA') {
              const t = JSON.stringify(errorData);
              const e = new Error(`Unified sync failed: ${t}`) as Error & { status?: number };
              e.status = res.status; throw e;
            }
            // Still STALE_DATA even after fast-forward → genuinely stuck → hard-block below.
          } else {
            const t = await res.text();
            const e = new Error(`Unified sync failed: ${t}`) as Error & { status?: number };
            e.status = res.status; throw e;
          }
        }

        console.error("📵 Stale data detected - your book is out of date");
        // Clear pending syncs so a manual refresh won't re-trigger the same stale sync
        pendingSyncs.clear();
        // Capture the about-to-be-discarded edit (the update nodes with content) so the
        // overlay can offer "download my unsaved edit (.md)" — the user sees and keeps
        // the sentence they wrote before it's thrown away. (The historyLog batch is
        // parked 'stale' by the caller's catch so it never replays.)
        const lostNodes = (unifiedPayload.nodes || [])
          .filter((n): n is PublicNode => Boolean(n && (n as PublicNode).content))
          .map(n => ({ id: (n as any).startLine ?? (n as any).id, content: (n as PublicNode).content }));
        // Hard-block via the same overlay used for cross-tab edits — this is the same
        // "you're stale, refresh" situation, just detected cross-device (BroadcastChannel
        // can't see other devices, so the server's 409 is the only signal). Blocking +
        // user-initiated refresh is intentional: the user must SEE why their edit is going.
        import('../../utilities/BroadcastListener')
          .then(({ showStaleTabOverlay }) => showStaleTabOverlay(
            "You edited a stale version of this book. To load the latest, your recent edits must be discarded. Download them first if you want to keep them. Apologies comrade.",
            bookId,
            lostNodes
          ))
          .catch(() => { /* overlay module unavailable — the thrown error still glows red */ });
        // Throw a specific error so callers can identify stale data issues. classifySyncError
        // returns null for STALE_DATA, so glowCloudRed won't also show a toast over the overlay.
        const staleError = new Error(errorData.message || 'Book is out of date') as Error & {
          code?: string; status?: number; serverTimestamp?: unknown; lostNodes?: unknown;
        };
        staleError.code = 'STALE_DATA';
        staleError.status = 409;
        staleError.serverTimestamp = errorData.server_timestamp;
        staleError.lostNodes = lostNodes;
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
  recordAckedServerTs(bookId, (result as { server_timestamp?: unknown }).server_timestamp);
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
    // The `item.store === 'x'` checks narrow `item.data`/`item.originalData` to that
    // store's record type (SyncQueueItem is a discriminated union over `store`), so
    // the nodes/library branches need no cast. The `else` branches push into a
    // store-indexed array `historyLogPayload.updates[item.store]`; TS can't prove
    // that the union-typed value matches the union-keyed array element (a correlated
    // index access it cannot express), so a single `as unknown[]` cast remains there.
    if (item.type === "update") {
      // Add the new state to 'updates'
      if (item.store === "nodes") {
        historyLogPayload.updates.nodes.push(toPublicNode(item.data)!);
      } else if (item.store === "library") {
        historyLogPayload.updates.library = item.data;
      } else {
        (historyLogPayload.updates[item.store] as unknown[]).push(item.data);
      }

      // Add the original state (if it exists) to 'deletions'
      if (item.originalData) {
        if (item.store === "nodes") {
          historyLogPayload.deletions.nodes.push(toPublicNode(item.originalData)!);
        } else if (item.store === "library") {
          historyLogPayload.deletions.library = item.originalData;
        } else {
          (historyLogPayload.deletions[item.store] as unknown[]).push(item.originalData);
        }
      }
    } else if (item.type === "delete") {
      // Add the deleted record to 'deletions'
      if (item.data) {
        if (item.store === "nodes") {
          historyLogPayload.deletions.nodes.push(toPublicNode(item.data)!);
        } else {
          (historyLogPayload.deletions[item.store] as unknown[]).push(item.data);
        }
      }
    }
  }

  // --- Optimistic-concurrency base ---
  // The server version this client last knew (set on pull + after each successful sync;
  // NOT bumped by local edits). The server 409s if its current timestamp is newer than this.
  // Read from the book's library record so it's correct even when this batch carries no
  // library update, and stash it on the historyLog payload so a REPLAYED batch keeps the
  // base it had at queue time.
  let baseTimestamp: number | undefined;
  try {
    const baseDb = await openDatabase();
    const libRec = await new Promise<LibraryRecord | undefined>((resolve, reject) => {
      const req = baseDb.transaction("library", "readonly").objectStore("library").get(bookId);
      req.onsuccess = () => resolve(req.result as LibraryRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    baseTimestamp = libRec?.base_timestamp ?? libRec?.timestamp;
  } catch (e) {
    console.warn("Could not read base_timestamp for sync:", e);
  }
  historyLogPayload.base_timestamp = baseTimestamp;

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
      base_timestamp?: number;
      updates: {
        nodes: NodeRecord[]; hypercites: HyperciteRecord[]; hyperlights: HyperlightRecord[];
        footnotes: FootnoteRecord[]; bibliography: BibliographyRecord[]; library: LibraryRecord | null;
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
      base_timestamp: baseTimestamp,
      updates: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], bibliography: [], library: null },
      deletions: { nodes: [], hyperlights: [], hypercites: [], footnotes: [], bibliography: [] },
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

    const syncResult = await executeSyncPayload(syncPayload);
    _serverErrorStreak.delete(bookId); // success → reset the 5xx streak for this book

    // Advance the optimistic-concurrency base to the server's authoritative post-write
    // version, so the NEXT edit compares against the new baseline (and consecutive edits
    // from THIS client never self-conflict). Prefer the server's returned timestamp; fall
    // back to the library timestamp we just sent (covers an older server that doesn't
    // return one yet — the server adopted our value on success).
    const newBase =
      (typeof (syncResult as { server_timestamp?: unknown })?.server_timestamp === 'number'
        ? (syncResult as { server_timestamp: number }).server_timestamp
        : undefined)
      ?? syncPayload.updates.library?.timestamp
      ?? baseTimestamp;
    // MONOTONIC advance via the shared helper: it only ever RAISES base_timestamp, so a stale
    // or echoed newBase can never drag the base backwards and re-introduce a false conflict
    // (the previous inline `= newBase` write was non-monotonic). Best-effort — only warns.
    await advanceBaseTimestamp(bookId, newBase);

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
    // 409 STALE_DATA is terminal, NOT a retryable failure: the server is newer, so
    // re-POSTing this batch will 409 forever. Mark it 'stale' so retryFailedBatches
    // skips it on the next boot (instead of 'failed', which it would replay).
    const isStale = (error as { code?: string }).code === 'STALE_DATA';
    if (logEntry) {
      logEntry.status = isStale ? "stale" : "failed";
      await updateHistoryLog(logEntry);
      console.error(`❌ Sync ${isStale ? 'rejected as stale' : 'failed'} for batch ${logEntry.id}:`, (error as Error).message);
    } else {
      console.error(`❌ Non-node sync ${isStale ? 'rejected as stale' : 'failed'}:`, (error as Error).message);
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
        import('../../integrity/reporter')
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
  const fallbackBookId = asBookId(mainContent?.id || book || "latest");

  for (const [key, item] of itemsToSync) {
    const itemBook = item.data?.book || fallbackBookId;
    if (!itemsByBook.has(itemBook)) {
      itemsByBook.set(itemBook, new Map());
    }
    itemsByBook.get(itemBook)!.set(key, item);
  }

  // Sync each book's items separately. Serialize per book so two overlapping drains can't race
  // on base_timestamp (see _bookSyncChain). Different books still run in parallel.
  for (const [bookId, bookItems] of itemsByBook) {
    await runSerializedPerKey(_bookSyncChain, bookId, () => syncItemsForBook(bookId, bookItems));
  }

}, 3000);

/**
 * Sync all IndexedDB data to PostgreSQL for a specific book (BLOCKING)
 *
 * ⚠️ WARNING: This is a BLOCKING sync implementation created during refactor.
 * It reimplements sync logic instead of using the proven indexedDB/serverSync functions.
 *
 * WHEN TO USE:
 * - ✅ Critical operations requiring immediate sync confirmation
 * - ✅ Full book exports or snapshots
 *
 * WHEN NOT TO USE:
 * - ❌ Background/automatic syncing (use indexedDB/serverSync:syncIndexedDBtoPostgreSQL() instead)
 * - ❌ Edit operations (already handled by debouncedMasterSync)
 * - ❌ Import operations (use non-blocking sync)
 *
 * DIFFERENCE FROM indexedDB/serverSync:syncIndexedDBtoPostgreSQL():
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
        nodes: nodes.map(toPublicNode).filter((c): c is PublicNode => Boolean(c)),
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
