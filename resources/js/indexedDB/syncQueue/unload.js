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

  // ✅ FIX: Get book ID from DOM instead of stale global variable
  const mainContent = document.querySelector('.main-content');
  const bookId = mainContent?.id || book || "latest";
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

  // Send to beacon sync endpoint
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
}
