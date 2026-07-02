/**
 * SaveQueue Module
 *
 * Manages debounced save operations and batch deletions for the editor.
 * Handles queuing node updates/additions and deletions with configurable debounce delays.
 *
 * The post-save / full-book integrity verification + self-healing subsystem lives in
 * ./integrityMonitor (IntegrityMonitor), driven uni-directionally from here.
 */

import {
  batchUpdateIndexedDBRecords,
  batchDeleteIndexedDBRecords,
  deleteIndexedDBRecordWithRetry
} from '../../indexedDB/index';
import { isPasteOperationActive } from '../../paste/pasteState';
import { verbose } from '../../utilities/logger';
import { clearChunkLoadingInProgress } from '../../lazyLoader/utilities/chunkLoadingState';
import { markCacheDirty } from '../../lazyLoader/utilities/cacheState';
import { debounce } from '../../utilities/debounce';
import { invalidateSearchIndex } from '../../search/inTextSearch/searchToolbar';
import { reportIDBFailure, reportIDBSuccess, isIDBBroken } from '../../indexedDB/core/healthMonitor';
import { TAB_ID, markBookEditedLocally } from '../../utilities/BroadcastListener';
import { book as currentBook } from '../../app';
import { hidePasteUndoToast } from '../../paste/ui/pasteUndoToast';
import { clearPasteSnapshot } from '../../paste/pasteSnapshot';
import { asDataNodeId, asBookId, LATEST, type LineId, type BookId } from '../../utilities/idHelpers';
import {
  DEBOUNCE_DELAYS,
  type DebouncedVoidFn,
  type PendingNode,
  type DeletionData,
  type PendingSaves,
  type IntegritySurface,
} from './types';
import { IntegrityMonitor } from './integrityMonitor';

// Re-export debounce for backwards compatibility
export { debounce };

// ================================================================
// SAVE QUEUE CLASS
// ================================================================

export class SaveQueue implements IntegritySurface {
  bookId: BookId | null;
  _destroyed: boolean;
  pendingSaves: PendingSaves;
  currentSavePromise: Promise<void> | null;
  integrity: IntegrityMonitor;
  _forceBypassPasteGuard: boolean;
  _pasteGuardDeferrals: number;
  _lastInputTimestamp: number;
  debouncedSaveNode: DebouncedVoidFn;
  debouncedBatchDelete: DebouncedVoidFn;
  monitor: ReturnType<typeof setInterval> | null;

  constructor(bookId: BookId | null = null) {
    this.bookId = bookId;
    this._destroyed = false;
    // Track what needs to be saved
    this.pendingSaves = {
      nodes: new Map(),
      deletions: new Set(),
      lastActivity: null
    };

    // 🔑 CRITICAL: Track save completion for proper close handling
    this.currentSavePromise = null;

    // Post-save / full-book integrity verification + self-healing.
    this.integrity = new IntegrityMonitor(this);

    // Paste guard state
    this._forceBypassPasteGuard = false;
    this._pasteGuardDeferrals = 0;
    this._lastInputTimestamp = 0;

    // Bind methods
    this.saveNodeToDatabase = this.saveNodeToDatabase.bind(this);
    this.processBatchDeletions = this.processBatchDeletions.bind(this);

    // Create debounced functions
    this.debouncedSaveNode = debounce(this.saveNodeToDatabase, DEBOUNCE_DELAYS.SAVES);
    this.debouncedBatchDelete = debounce(this.processBatchDeletions, DEBOUNCE_DELAYS.SAVES);

    // Monitor for debugging (optional)
    this.monitor = null;
  }

  /**
   * Add node to pending saves queue
   */
  queueNode(IDnumerical: LineId, action: string = 'update', bookId: BookId | null = null): void {
    this.pendingSaves.nodes.set(IDnumerical, { id: IDnumerical, action, bookId });
    this.pendingSaves.lastActivity = Date.now();

    // Reset full-verification timer so it can't fire while saves are pending.
    // It will be rescheduled after the next save completes.
    this.integrity.cancelFullVerification();

    // Dismiss large-paste undo toast on any subsequent edit
    hidePasteUndoToast();
    clearPasteSnapshot();

    this.debouncedSaveNode();
  }

  recordInputEvent(): void {
    this._lastInputTimestamp = Date.now();
  }

  /**
   * Add node to pending deletions queue
   * Captures data-node-id and bookId from DOM before element is removed
   */
   queueDeletion(IDnumerical: LineId, nodeElement: HTMLElement | null = null, explicitBookId: BookId | null = null): void {
    // ✅ FIX: Capture data-node-id - prefer passed element, fallback to DOM lookup
    const element = nodeElement || document.getElementById(IDnumerical);
    const rawDataNodeId = element?.getAttribute('data-node-id');
    const dataNodeID = rawDataNodeId ? asDataNodeId(rawDataNodeId) : null;

    // ✅ FIX: Determine bookId - use explicit if provided, else find from context
    let finalBookId: BookId | null = explicitBookId;
    if (!finalBookId) {
      if (element) {
        // Check element's closest sub-book container
        const subBookEl = element.closest('[data-book-id]') as HTMLElement | null;
        if (subBookEl) {
          finalBookId = subBookEl.dataset.bookId ? asBookId(subBookEl.dataset.bookId) : null;
        }
      }
      // Fallback to main content if not found
      if (!finalBookId) {
        const mainContent = document.querySelector('.main-content');
        finalBookId = asBookId(mainContent?.id || this.bookId || 'latest');
      }
    }

    // Store both IDnumerical and {dataNodeId, bookId} in a Map instead of Set
    if (!this.pendingSaves.deletionMap) {
      this.pendingSaves.deletionMap = new Map();
    }
    this.pendingSaves.deletionMap.set(IDnumerical, { dataNodeId: dataNodeID, bookId: finalBookId ?? LATEST });

    // Keep deletions Set for backward compatibility
    this.pendingSaves.deletions.add(IDnumerical);
    this.pendingSaves.lastActivity = Date.now();

    // ⚠️ DIAGNOSTIC: Log stack trace when deletion queue grows large
    if (this.pendingSaves.deletions.size === 11) {
      console.warn(`⚠️ DELETION QUEUE HIT 11 NODES - capturing stack`, {
        stack: new Error().stack,
        currentQueue: Array.from(this.pendingSaves.deletions),
        timestamp: Date.now()
      });
    }

    this.debouncedBatchDelete();
  }

  /**
   * Save queued nodes to database
   */
  async saveNodeToDatabase(): Promise<void> {
    if (this._destroyed) return;
    verbose.content(`saveNodeToDatabase called, pending nodes: ${this.pendingSaves.nodes.size}`, 'divEditor/saveQueue/index.ts');
    if (this.pendingSaves.nodes.size === 0) {
      return;
    }

    // Paste guard: defer saves while paste is restructuring the DOM
    if (isPasteOperationActive() && !this._forceBypassPasteGuard) {
      this._pasteGuardDeferrals++;
      if (this._pasteGuardDeferrals > 10) {
        console.warn('[SaveQueue] Paste guard exceeded max deferrals — saving anyway');
        this._pasteGuardDeferrals = 0;
      } else {
        verbose.content(`[SaveQueue] Paste in progress — deferring save (attempt ${this._pasteGuardDeferrals})`, 'divEditor/saveQueue/index.ts');
        this.debouncedSaveNode();
        return;
      }
    }
    this._pasteGuardDeferrals = 0;

    // Circuit-breaker: if IDB is broken, leave items queued for retry after recovery
    if (isIDBBroken()) {
      console.warn('🎯 saveNodeToDatabase: IDB broken — skipping (items stay queued)');
      return;
    }

    const nodesToSave = Array.from(this.pendingSaves.nodes.values());
    verbose.content(`saveNodeToDatabase: processing ${nodesToSave.length} nodes`, 'divEditor/saveQueue/index.ts');
    this.pendingSaves.nodes.clear();

    verbose.content(`Processing ${nodesToSave.length} pending node saves`, 'divEditor/saveQueue/index.ts');

    const updates = nodesToSave.filter(n => n.action === 'update');
    const additions = nodesToSave.filter(n => n.action === 'add');
    const deletions = nodesToSave.filter(n => n.action === 'delete');

    // 🔑 CRITICAL: Create save operation promise for completion tracking
    this.currentSavePromise = (async () => {
      try {
        const recordsToUpdate = [...updates, ...additions].filter(node => {
          let element: HTMLElement | null = null;
          const effectiveBookId = node.bookId || this.bookId;
          if (effectiveBookId) {
            const container = document.querySelector(`[data-book-id="${effectiveBookId}"]`)
              || document.getElementById(effectiveBookId);
            element = container?.querySelector(`[id="${node.id}"]`) as HTMLElement | null;
          }
          if (!element) {
            element = document.getElementById(node.id);
          }
          if (!element) {
            console.warn(`⚠️ Skipping save for node ${node.id} - element not found in DOM`);
            return false;
          }
          return true;
        });

        if (recordsToUpdate.length > 0) {
          verbose.content(`saveNodeToDatabase: saving ${recordsToUpdate.length} records to IndexedDB`, 'divEditor/saveQueue/index.ts');

          // Group records by bookId for correct sub-book saves
          const recordsByBookId = new Map<BookId | null, PendingNode[]>();
          for (const record of recordsToUpdate) {
            const effectiveBookId = record.bookId || this.bookId || null;
            if (!recordsByBookId.has(effectiveBookId)) {
              recordsByBookId.set(effectiveBookId, []);
            }
            recordsByBookId.get(effectiveBookId)!.push(record);
          }

          for (const [bookId, records] of recordsByBookId) {
            // PendingNode[] satisfies BatchRecord[] (it carries the required `id`);
            // the extra action/bookId fields are ignored by the writer. No cast needed.
            await batchUpdateIndexedDBRecords(records, bookId ? { bookId } : {});
          }

          verbose.content('saveNodeToDatabase: IndexedDB save complete', 'divEditor/saveQueue/index.ts');
          reportIDBSuccess();
          // ✅ Mark cache dirty after successful saves
          markCacheDirty();
          // ✅ Invalidate search index so next search reflects edits
          invalidateSearchIndex();
          // ✅ Notify other tabs that this book was edited
          {
            const editedBooks = new Set<BookId | null>();
            for (const [bk] of recordsByBookId) {
              editedBooks.add(bk || currentBook);
            }
            for (const bk of editedBooks) {
              if (bk) {
                // Mark our own edit BEFORE broadcasting so the listener (even a
                // separate module instance in this same tab) ignores the echo
                // instead of firing the "edited in another tab" overlay.
                markBookEditedLocally(bk);
                const bc = new BroadcastChannel('hyperlit-tab-coordination');
                bc.postMessage({ type: 'BOOK_EDITED', book: bk, tabId: TAB_ID });
                bc.close();
              }
            }
          }
          // Non-blocking integrity verification after successful save
          this.integrity.verifyAfterSave(recordsByBookId);
        } else {
          verbose.content('saveNodeToDatabase: no records to update (elements not found in DOM)', 'divEditor/saveQueue/index.ts');
        }

        if (deletions.length > 0) {
          await Promise.all(deletions.map(node =>
            deleteIndexedDBRecordWithRetry(node.id)
          ));
          // ✅ Mark cache dirty after successful deletions
          markCacheDirty();
          // ✅ Invalidate search index so next search reflects edits
          invalidateSearchIndex();
        }

      } catch (error) {
        console.error('❌ Error in batch save:', error);
        const shouldStop = reportIDBFailure(error, {
          retryFn: () => {
            // Re-queue and retry after recovery
            nodesToSave.forEach(node => this.pendingSaves.nodes.set(node.id, node));
            this.debouncedSaveNode();
          }
        });
        if (!shouldStop) {
          // Transient error — re-queue once for normal debounce retry
          nodesToSave.forEach(node => this.pendingSaves.nodes.set(node.id, node));
        }
      } finally {
        this.currentSavePromise = null;
      }
    })();

    // Wait for this save to complete
    await this.currentSavePromise;
  }

  /**
   * Process batch deletions from queue
   */
  async processBatchDeletions(): Promise<void> {
    if (this.pendingSaves.deletions.size === 0) return;

    // Circuit-breaker: if IDB is broken, leave items queued for retry after recovery
    if (isIDBBroken()) {
      console.warn('🎯 processBatchDeletions: IDB broken — skipping (items stay queued)');
      return;
    }

    const nodeIdsToDelete = Array.from(this.pendingSaves.deletions);

    // ⚠️ DIAGNOSTIC: Log when many nodes are being batch deleted
    if (nodeIdsToDelete.length > 10) {
      console.warn(`⚠️ SAVE_QUEUE BATCH DELETE: ${nodeIdsToDelete.length} nodes`, {
        stack: new Error().stack,
        nodeIds: nodeIdsToDelete.slice(0, 10),
        timestamp: Date.now()
      });
    }

    // ✅ FIX: Get deletion data map with data-node-id and bookId for deleted nodes
    const deletionDataMap = this.pendingSaves.deletionMap || new Map<LineId, DeletionData>();

    // ✅ FIX: Group node IDs by bookId for correct deletion
    const nodesByBookId = new Map<BookId, LineId[]>();
    nodeIdsToDelete.forEach(nodeId => {
      const deletionData = deletionDataMap.get(nodeId);
      const bookId = deletionData?.bookId || this.bookId || LATEST;
      if (!nodesByBookId.has(bookId)) {
        nodesByBookId.set(bookId, []);
      }
      nodesByBookId.get(bookId)!.push(nodeId);
    });

    // ✅ FIX: Create deletionMap for each book group (containing only data-node-ids)
    const buildDeletionMapForBook = (nodeIds: LineId[], _bookId: BookId): Map<string, string | null | undefined> => {
      const map = new Map<string, string | null | undefined>();
      nodeIds.forEach(nodeId => {
        const data = deletionDataMap.get(nodeId);
        map.set(nodeId, data?.dataNodeId || null);
      });
      return map;
    };

    // ✅ OPTIMIZATION: Log data-node-id capture rate (verbose mode)
    const dataNodeIDCount = Array.from(deletionDataMap.values()).filter(v => v?.dataNodeId).length;
    verbose.content(`DATA-NODE-ID CAPTURE: ${dataNodeIDCount}/${nodeIdsToDelete.length} nodes have data-node-ids (${((dataNodeIDCount/nodeIdsToDelete.length)*100).toFixed(1)}%)`, 'divEditor/saveQueue/index.ts');
    verbose.content(`BOOK GROUPS: ${nodesByBookId.size} books with nodes to delete`, 'divEditor/saveQueue/index.ts');

    this.pendingSaves.deletions.clear();
    this.pendingSaves.deletionMap = new Map(); // Clear the map

    verbose.content(`Batch deleting ${nodeIdsToDelete.length} nodes`, 'divEditor/saveQueue/index.ts');

    try {
      // ✅ FIX: Process deletions grouped by bookId
      for (const [bookId, nodeIds] of nodesByBookId) {
        const bookDeletionMap = buildDeletionMapForBook(nodeIds, bookId);
        await batchDeleteIndexedDBRecords(nodeIds, bookDeletionMap, bookId);
        verbose.content(`Batch deleted ${nodeIds.length} nodes from book ${bookId}`, 'divEditor/saveQueue/index.ts');
      }

      reportIDBSuccess();
      // ✅ Notify other tabs that this book was edited (deletions)
      {
        const editedBooks = new Set<BookId | null>();
        for (const [bk] of nodesByBookId) {
          editedBooks.add(bk || currentBook);
        }
        for (const bk of editedBooks) {
          if (bk) {
            // Mark our own edit BEFORE broadcasting (mirrors the save path above) so the
            // listener ignores this echo instead of firing the "edited in another tab"
            // overlay on the tab's OWN deletions. Without this, a code-split TAB_ID race
            // leaves the deletion path with no self-skip — e.g. creating a hyperlight/
            // hypercite (which deletes+recreates nodes) popped the stale-tab overlay and
            // blocked the selection toolbar.
            markBookEditedLocally(bk);
            const bc = new BroadcastChannel('hyperlit-tab-coordination');
            bc.postMessage({ type: 'BOOK_EDITED', book: bk, tabId: TAB_ID });
            bc.close();
          }
        }
      }
    } catch (error) {
      console.error('❌ Error in batch deletion:', error);
      const shouldStop = reportIDBFailure(error, {
        retryFn: () => {
          // Re-queue and retry after recovery
          nodeIdsToDelete.forEach(id => this.pendingSaves.deletions.add(id));
          nodeIdsToDelete.forEach(id => {
            const data = deletionDataMap.get(id);
            if (data) {
              if (!this.pendingSaves.deletionMap) this.pendingSaves.deletionMap = new Map();
              this.pendingSaves.deletionMap.set(id, data);
            }
          });
          this.debouncedBatchDelete();
        }
      });
      if (!shouldStop) {
        // Transient error — re-queue once for normal debounce retry
        nodeIdsToDelete.forEach(id => this.pendingSaves.deletions.add(id));
        nodeIdsToDelete.forEach(id => {
          const data = deletionDataMap.get(id);
          if (data) {
            if (!this.pendingSaves.deletionMap) this.pendingSaves.deletionMap = new Map();
            this.pendingSaves.deletionMap.set(id, data);
          }
        });
      }
    } finally {
      // ✅ Clear chunk loading flags to re-enable lazy loading
      clearChunkLoadingInProgress();
      verbose.content('Cleared chunk loading flags - lazy loading re-enabled', 'divEditor/saveQueue/index.ts');

      // ✅ Mark cache dirty so it refreshes before next chunk load
      markCacheDirty();
      // ✅ Invalidate search index so next search reflects deletions
      invalidateSearchIndex();
    }
  }

  /**
   * Force save all pending changes immediately
   */
  async flush(): Promise<void> {
    verbose.content('Flushing all pending saves...', 'divEditor/saveQueue/index.ts');

    // Clear debounce timers and execute immediately
    this.debouncedSaveNode.cancel();
    this.debouncedBatchDelete.cancel();

    // 🔑 CRITICAL: Wait for any ongoing save to complete first
    if (this.currentSavePromise) {
      verbose.content('[SaveQueue] Waiting for ongoing save to complete...', 'divEditor/saveQueue/index.ts');
      await this.currentSavePromise;
      verbose.content('[SaveQueue] Ongoing save completed', 'divEditor/saveQueue/index.ts');
    }

    // Bypass paste guard for explicit flushes (page unload, paste verification)
    this._forceBypassPasteGuard = true;
    try {
      // Await the async save operations to ensure they complete
      if (this.pendingSaves.nodes.size > 0) {
        await this.saveNodeToDatabase();
      }

      if (this.pendingSaves.deletions.size > 0) {
        await this.processBatchDeletions();
      }

      // 🔑 CRITICAL: Wait for any save that started during this flush
      if (this.currentSavePromise) {
        verbose.content('[SaveQueue] Waiting for final save to complete...', 'divEditor/saveQueue/index.ts');
        await this.currentSavePromise;
        verbose.content('[SaveQueue] Final save completed', 'divEditor/saveQueue/index.ts');
      }
    } finally {
      this._forceBypassPasteGuard = false;
    }

    verbose.content('SaveQueue flush complete', 'divEditor/saveQueue/index.ts');
  }

  /**
   * Check if there are pending operations
   */
  get hasPending(): boolean {
    return this.pendingSaves.nodes.size > 0 || this.pendingSaves.deletions.size > 0;
  }

  /**
   * Start monitoring pending saves (for debugging)
   */
  startMonitoring(): void {
    if (this.monitor) {
      clearInterval(this.monitor);
    }

    this.monitor = setInterval(() => {
      const now = Date.now();
      const timeSinceLastActivity = this.pendingSaves.lastActivity
        ? now - this.pendingSaves.lastActivity
        : null;

      if (this.hasPending) {
        verbose.content(`Pending saves: ${this.pendingSaves.nodes.size} nodes, ${this.pendingSaves.deletions.size} deletions (${timeSinceLastActivity}ms since last activity)`, 'divEditor/saveQueue/index.ts');
      }
    }, 5000);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = null;
      verbose.content("Pending saves monitor stopped", 'divEditor/saveQueue/index.ts');
    }
  }

  /**
   * Cleanup and cancel all pending operations
   */
  destroy(): void {
    this._destroyed = true;
    this.debouncedSaveNode.cancel();
    this.debouncedBatchDelete.cancel();
    this.integrity.destroy();
    this.stopMonitoring();
    this.pendingSaves.nodes.clear();
    this.pendingSaves.deletions.clear();
  }
}
