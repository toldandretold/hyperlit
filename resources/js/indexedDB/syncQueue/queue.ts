/**
 * Sync Queue Module
 * Manages the queue of pending sync operations
 */

import { isUndoRedoInProgress } from '../../utilities/operationState';
import type { BookId, SyncOperationType, SyncQueueItem, SyncStoreRecordMap, SyncStore } from '../types';

// Global pending syncs map
export const pendingSyncs = new Map<string, SyncQueueItem>();

// Import dependencies (will be injected)
let debouncedMasterSync: (() => void) | undefined;

// Initialization function to inject dependencies
export function initSyncQueueDependencies(deps: { debouncedMasterSync: () => void }): void {
  debouncedMasterSync = deps.debouncedMasterSync;
}

/**
 * Queue an operation for syncing to PostgreSQL
 * Operations are batched and synced via debounced masterSync
 *
 * @param store - Store name (nodes, hyperlights, hypercites, library)
 * @param id - Record identifier
 * @param type - Operation type (update, delete, hide)
 * @param data - New data state
 * @param originalData - Original data state (for undo)
 * @param skipRedoClear - Unused (kept for backward compatibility with callers)
 */
export function queueForSync<S extends SyncStore>(
  store: S,
  id: string | number,
  type: SyncOperationType = "update",
  // Accept a full record OR a partial: delete/hide sites legitimately queue
  // partial payloads (e.g. footnote delete passes just { book, footnoteId };
  // a node delete passes none). The store↔data coupling is still enforced.
  data: SyncStoreRecordMap[S] | Partial<SyncStoreRecordMap[S]> | null = null,
  originalData: SyncStoreRecordMap[S] | Partial<SyncStoreRecordMap[S]> | null = null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  skipRedoClear = false,
): void {
  // ✅ FIX: Skip queuing entirely during undo/redo to prevent spurious history batches
  // The IndexedDB transaction has already committed - we just don't want to create a new history entry
  if (isUndoRedoInProgress()) {
    console.log(`⏭️ Skipping sync queue during undo/redo for ${store}:${id}`);
    return;
  }

  const itemBook = data?.book || '';
  const key = `${store}-${itemBook}-${id}`;

  // 🔍 LOGGING for hyperlights specifically
  if (store === "hyperlights") {
    const existing = pendingSyncs.get(key);
    console.log(`📤 queueForSync: ${store} | key=${key} | type=${type} | existing=${existing ? 'YES (will update)' : 'NO (new entry)'}`);
    if (data) {
      console.log(`   book=${data.book} | hyperlight_id=${(data as Record<string, unknown>).hyperlight_id} | node_ids=${JSON.stringify((data as Record<string, unknown>).node_id)}`);
    }
  }

  if (type === "update" && !data) {
    console.warn(`⚠️ queueForSync called for update on ${key} without data.`);
    return;
  }

  // Preserve the FIRST originalData when the same key is queued multiple times.
  // This ensures we keep the TRUE original state for undo, not an intermediate state
  // (e.g., when footnote renumbering updates the same node again before sync fires).
  const existing = pendingSyncs.get(key);
  if (existing && existing.originalData) {
    // Keep the first originalData (the true original state). `existing` is the
    // broad SyncQueueItem union; this key is for the same `store`, so its
    // originalData is the right shape — narrow via the same-store assumption.
    originalData = existing.originalData as SyncStoreRecordMap[S];
  }

  // Single contained cast: the public params accept Partial<…> for delete/hide,
  // but the stored item type is the full record-or-null. This is the one place
  // the partial-vs-full seam is bridged — replacing scattered call-site `as any`.
  pendingSyncs.set(key, { store, id, type, data, originalData } as SyncQueueItem);

  // Not injected = programming error; calling through undefined throws, same as the
  // pre-TS behaviour.
  debouncedMasterSync!();
}

/**
 * Clear all pending syncs for a specific book
 * Used when changing books or resetting state
 *
 * @param bookId - Book identifier
 * @returns Number of syncs cleared
 */
export function clearPendingSyncsForBook(bookId: BookId): number {
  const keysToDelete: string[] = [];
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
