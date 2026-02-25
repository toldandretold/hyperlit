/**
 * Sync Queue Module
 * Manages the queue of pending sync operations
 */

import { isUndoRedoInProgress } from '../../utilities/operationState.js';

// Global pending syncs map
export const pendingSyncs = new Map();

// Import dependencies (will be injected)
let clearRedoHistory, debouncedMasterSync;

// Initialization function to inject dependencies
export function initSyncQueueDependencies(deps) {
  clearRedoHistory = deps.clearRedoHistory;
  debouncedMasterSync = deps.debouncedMasterSync;
}

/**
 * Queue an operation for syncing to PostgreSQL
 * Operations are batched and synced via debounced masterSync
 *
 * @param {string} store - Store name (nodes, hyperlights, hypercites, library)
 * @param {string|number} id - Record identifier
 * @param {string} type - Operation type (update, delete, hide)
 * @param {Object} data - New data state
 * @param {Object} originalData - Original data state (for undo)
 * @param {boolean} skipRedoClear - If true, don't clear redo history (for automatic operations like undo/redo refresh)
 */
export function queueForSync(store, id, type = "update", data = null, originalData = null, skipRedoClear = false) {
  // ✅ FIX: Skip queuing entirely during undo/redo to prevent spurious history batches
  // The IndexedDB transaction has already committed - we just don't want to create a new history entry
  if (isUndoRedoInProgress()) {
    console.log(`⏭️ Skipping sync queue during undo/redo for ${store}:${id}`);
    return;
  }

  const itemBook = data?.book || '';
  const key = `${store}-${itemBook}-${id}`;
  if (type === "update" && !data) {
    console.warn(`⚠️ queueForSync called for update on ${key} without data.`);
    return;
  }

  // Preserve the FIRST originalData when the same key is queued multiple times.
  // This ensures we keep the TRUE original state for undo, not an intermediate state
  // (e.g., when footnote renumbering updates the same node again before sync fires).
  const existing = pendingSyncs.get(key);
  if (existing && existing.originalData) {
    // Keep the first originalData (the true original state)
    originalData = existing.originalData;
  }

  pendingSyncs.set(key, { store, id, type, data, originalData });

  // Only clear redo history for genuine user edits, not automatic operations
  if (!skipRedoClear) {
    const book = window.book || "latest";
    clearRedoHistory(book);
  }
  debouncedMasterSync();
}

/**
 * Clear all pending syncs for a specific book
 * Used when changing books or resetting state
 *
 * @param {string} bookId - Book identifier
 * @returns {number} Number of syncs cleared
 */
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
