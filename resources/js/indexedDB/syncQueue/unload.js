/**
 * Unload Sync Module
 * Handles syncing on page unload using navigator.sendBeacon
 */

import { pendingSyncs } from './queue.js';
import { debouncedMasterSync } from './master.js';

// Dependencies
let book;

// Initialization function to inject dependencies
export function initUnloadSyncDependencies(deps) {
  book = deps.book;
}

// Track whether we're currently syncing on unload
let isSyncingOnUnload = false;

/**
 * Sync pending changes on page unload
 * Uses navigator.sendBeacon for reliability during page transitions
 *
 * @returns {string|undefined} Message for beforeunload confirmation
 */
function syncOnUnload() {
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
  const fallbackBookId = mainContent?.id || book || "latest";

  const itemsByBook = new Map();
  for (const item of pendingSyncs.values()) {
    const itemBook = item.data?.book || fallbackBookId;
    if (!itemsByBook.has(itemBook)) {
      itemsByBook.set(itemBook, []);
    }
    itemsByBook.get(itemBook).push(item);
  }

  const syncUrl = "/api/db/sync/beacon";
  let allSuccess = true;

  for (const [bookId, items] of itemsByBook) {
    const payload = {
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

    for (const item of items) {
      if (item.type === "update") {
        if (!item.data) continue;
        switch (item.store) {
          case "nodes":
            payload.updates.nodes.push(item.data);
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
          case "nodes":
            payload.deletions.nodes.push({
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

    const blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });

    const success = navigator.sendBeacon(syncUrl, blob);
    if (success) {
      console.log(`✅ Beacon sync queued for book: ${bookId}`);
    } else {
      console.warn(`⚠️ Beacon sync failed for book: ${bookId}`);
      allSuccess = false;
    }
  }

  if (allSuccess) {
    console.log("✅ All beacon syncs successfully queued.");
    pendingSyncs.clear();
  } else {
    console.error("❌ Some beacon syncs failed. Data may be lost.");
  }

  // This message may be shown to the user in a confirmation dialog.
  return "Your latest changes are being saved. Are you sure you want to leave?";
}

/**
 * Setup event listeners for page unload sync
 * Should be called during application initialization
 */
export function setupUnloadSync() {
  window.addEventListener("beforeunload", (event) => {
    if (pendingSyncs.size > 0) {
      // Cancel any pending debounced sync, as the beacon will handle it.
      debouncedMasterSync.cancel?.();
      const message = syncOnUnload();
      // Standard way to show a confirmation prompt.
      event.preventDefault();
      event.returnValue = message;
      return message;
    }
  });

  // `pagehide` is a more reliable event for mobile devices.
  window.addEventListener("pagehide", syncOnUnload, { capture: true });

  // `visibilitychange` fires when switching apps or locking the screen on mobile.
  // Unlike pagehide, the page is still alive — so we can use async imports and
  // flush the full save pipeline (divEditor → IndexedDB → server sync).
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) return;
    try {
      const { flushInputDebounce, flushAllPendingSaves } = await import('../../divEditor/index.js');
      flushInputDebounce();
      await flushAllPendingSaves();
    } catch (e) {
      // divEditor not loaded (not in edit mode) — nothing to flush
    }
    // Flush any footnote annotation debounce timers
    try {
      const { flushPendingFootnoteSaves } = await import('../../footnotes/footnoteAnnotations.js');
      flushPendingFootnoteSaves();
    } catch (e) {
      // footnoteAnnotations not loaded — nothing to flush
    }
    // Flush debounced master sync to push everything to the server
    debouncedMasterSync.flush?.();
  });
}
