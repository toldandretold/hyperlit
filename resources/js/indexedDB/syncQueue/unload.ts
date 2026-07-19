/**
 * Unload Sync Module
 * Handles syncing on page unload using navigator.sendBeacon
 */

import { pendingSyncs } from './queue';
import { debouncedMasterSync } from './master';
import { flushPendingEdits } from '../../utilities/pendingEditsRegistry';
import { asBookId, type BookId, type SyncQueueItem, type SyncRecordData } from '../types';
// E2EE seam (docs/e2ee.md): the beacon is synchronous, so encrypted-book items
// are substituted from the pre-encrypted outbox; uncaptured ones are skipped
// and stay queued rather than ever leaving as plaintext.
import { isBookEncrypted } from '../../e2ee/registry';
import { getBeaconCiphertext, discardBeaconCiphertext } from '../../e2ee/outbox';
// The beacon is fire-and-forget: when it commits a library timestamp server-side, the
// base can NEVER advance from a response — so the NEXT session's first sync 409s against
// our own beacon write. Stamping the beacon with a ledgered sync_token (localStorage,
// survives the session boundary) lets that 409 self-recover. See sentSyncTokens.
import { generateSyncToken, recordSentSyncToken } from './sentSyncTokens';

// Dependencies
let book: BookId | null | undefined;

// Initialization function to inject dependencies
export function initUnloadSyncDependencies(deps: { book: BookId | null | undefined }): void {
  book = deps.book;
}

// Track whether we're currently syncing on unload
let isSyncingOnUnload = false;

/** Test-only: re-arm the once-per-page unload guard (mirrors
 *  master.ts __resetSyncConcurrencyStateForTests). No production callers. */
export function __resetUnloadOnceGuardForTests(): void {
  isSyncingOnUnload = false;
}

interface BeaconPayload {
  book: BookId;
  /** Optimistic-concurrency base (the server version this client last knew). */
  base_timestamp?: number;
  /** Ledgered write id (see sentSyncTokens) so a later 409 against this
   *  response-less write can be recognized as our own. */
  sync_token?: string;
  updates: {
    nodes: SyncRecordData[];
    hypercites: SyncRecordData[];
    hyperlights: SyncRecordData[];
    library: SyncRecordData | null;
  };
  deletions: {
    nodes: Array<{ book: BookId; startLine: string | number; _action: 'delete' }>;
    hyperlights: Array<{ book: BookId; hyperlight_id: string | number }>;
  };
}

/**
 * Sync pending changes on page unload
 * Uses navigator.sendBeacon for reliability during page transitions
 *
 * @returns Message for beforeunload confirmation
 */
function syncOnUnload(): string | undefined {
  // Prevent running multiple times if both pagehide and beforeunload fire.
  if (isSyncingOnUnload || pendingSyncs.size === 0) {
    return;
  }

  isSyncingOnUnload = true;
  console.log(
    `BEACON SYNC: Page is unloading. Attempting to sync ${pendingSyncs.size} items.`
  );

  // Group items by book so each sub-book syncs under its own book ID
  // (mirrors the grouping logic in debouncedMasterSync)
  const mainContent = document.querySelector('.main-content');
  const fallbackBookId = asBookId(mainContent?.id || book || "latest");

  const itemsByBook = new Map<BookId, Array<{ key: string; item: SyncQueueItem }>>();
  for (const [key, item] of pendingSyncs.entries()) {
    const itemBook = item.data?.book || fallbackBookId;
    if (!itemsByBook.has(itemBook)) {
      itemsByBook.set(itemBook, []);
    }
    itemsByBook.get(itemBook)!.push({ key, item });
  }

  const syncUrl = "/api/db/sync/beacon";
  let allSuccess = true;
  // Keys actually included in a successfully queued beacon — only these are
  // cleared from pendingSyncs (skipped encrypted items stay queued).
  const sentKeys: string[] = [];

  for (const [bookId, entries] of itemsByBook) {
    const bookEncrypted = isBookEncrypted(bookId);
    const bookKeys: string[] = [];
    const payload: BeaconPayload = {
      book: bookId,
      updates: {
        nodes: [],
        hypercites: [],
        hyperlights: [],
        library: null,
      },
      deletions: {
        nodes: [],
        hyperlights: [],
      },
    };

    for (const { key, item } of entries) {
      if (item.type === "update") {
        if (!item.data) continue;
        // E2EE: substitute the pre-encrypted outbox copy; if capture hasn't
        // settled yet, SKIP the item (it stays in pendingSyncs) — plaintext
        // must never ride the beacon for an encrypted book.
        let wireData: SyncRecordData = item.data;
        if (bookEncrypted) {
          const ciphertext = getBeaconCiphertext(key);
          if (!ciphertext) continue;
          wireData = ciphertext as SyncRecordData;
        }
        switch (item.store) {
          case "nodes":
            payload.updates.nodes.push(wireData);
            bookKeys.push(key);
            break;
          case "hypercites":
            payload.updates.hypercites.push(wireData);
            bookKeys.push(key);
            break;
          case "hyperlights":
            payload.updates.hyperlights.push(wireData);
            bookKeys.push(key);
            break;
          case "library":
            payload.updates.library = wireData;
            // The queued library record carries the (un-bumped) base set on pull/last sync.
            payload.base_timestamp = (item.data as { base_timestamp?: number })?.base_timestamp;
            bookKeys.push(key);
            break;
        }
      } else if (item.type === "delete") {
        // Deletions carry ids only (no content) — safe for encrypted books too.
        switch (item.store) {
          case "nodes":
            payload.deletions.nodes.push({
              book: bookId,
              startLine: item.id,
              _action: "delete",
            });
            bookKeys.push(key);
            break;
          case "hyperlights":
            payload.deletions.hyperlights.push({
              book: bookId,
              hyperlight_id: item.id,
            });
            bookKeys.push(key);
            break;
        }
      }
    }

    // Only a library-bearing beacon can advance the server's staleness clock —
    // that's the only case a future 409 could point back at this write.
    if (payload.updates.library) {
      const syncToken = generateSyncToken();
      recordSentSyncToken(syncToken);
      payload.sync_token = syncToken;
    }

    const blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });

    const success = navigator.sendBeacon(syncUrl, blob);
    if (success) {
      console.log(`✅ Beacon sync queued for book: ${bookId}`);
      sentKeys.push(...bookKeys);
    } else {
      console.warn(`⚠️ Beacon sync failed for book: ${bookId}`);
      allSuccess = false;
    }
  }

  // Clear only what actually rode a successful beacon; skipped encrypted items
  // (outbox not settled) and failed books stay queued for the next opportunity.
  for (const key of sentKeys) {
    pendingSyncs.delete(key);
    discardBeaconCiphertext(key);
  }
  if (!allSuccess) {
    console.error("❌ Some beacon syncs failed. Data may be lost.");
  } else {
    // pendingSyncs.size > 0 here = encrypted items skipped awaiting outbox capture.
    console.log(`✅ Beacon syncs queued (${pendingSyncs.size} encrypted item(s) retained).`);
  }

  // This message may be shown to the user in a confirmation dialog.
  return "Your latest changes are being saved. Are you sure you want to leave?";
}

/**
 * Setup event listeners for page unload sync
 * Should be called during application initialization
 */
export function setupUnloadSync(): void {
  window.addEventListener("beforeunload", (event) => {
    if (pendingSyncs.size > 0) {
      // Cancel any pending debounced sync, as the beacon will handle it.
      debouncedMasterSync.cancel?.();
      const message = syncOnUnload();
      // Standard way to show a confirmation prompt.
      event.preventDefault();
      event.returnValue = message as string;
      return message;
    }
    return undefined;
  });

  // `pagehide` is a more reliable event for mobile devices.
  window.addEventListener("pagehide", syncOnUnload, { capture: true });

  // `visibilitychange` fires when switching apps or locking the screen on mobile.
  // Unlike pagehide, the page is still alive — so we can use async imports and
  // flush the full save pipeline (divEditor → IndexedDB → server sync).
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) return;
    // Flush the editor input debounce + SaveQueue + footnote debounces via the registry —
    // no upward import into divEditor/footnotes (no cycle-breaker).
    await flushPendingEdits();
    // Flush debounced master sync to push everything to the server
    debouncedMasterSync.flush?.();
  });
}
