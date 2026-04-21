/**
 * SaveQueue Module
 *
 * Manages debounced save operations and batch deletions for the editor.
 * Handles queuing node updates/additions and deletions with configurable debounce delays.
 */

import {
  batchUpdateIndexedDBRecords,
  batchDeleteIndexedDBRecords,
  deleteIndexedDBRecordWithRetry
} from '../indexedDB/index.js';
import { isPasteOperationActive } from '../paste';
import { verbose } from '../utilities/logger.js';
import { clearChunkLoadingInProgress } from '../utilities/chunkLoadingState.js';
import { markCacheDirty } from '../utilities/cacheState.js';
import { debounce } from '../utilities/debounce.js';
import { invalidateSearchIndex } from '../search/inTextSearch/searchToolbar.js';
import { reportIDBFailure, reportIDBSuccess, isIDBBroken } from '../indexedDB/core/healthMonitor.js';
import { TAB_ID } from '../utilities/BroadcastListener.js';
import { book as currentBook } from '../app.js';
import { verifyNodesIntegrity } from '../integrity/verifier.js';
import { reportIntegrityFailure } from '../integrity/reporter.js';
import { hidePasteUndoToast } from '../paste/ui/pasteUndoToast.js';
import { clearPasteSnapshot } from '../paste/handlers/largePasteHandler.js';

// Re-export debounce for backwards compatibility
export { debounce };

// ================================================================
// DEBOUNCING INFRASTRUCTURE
// ================================================================

// Debounce delays (in milliseconds)
// 🚀 PERFORMANCE: Increased delays for better batching and mobile performance
const DEBOUNCE_DELAYS = {
  TYPING: 1500,       // Wait 1.5s after user stops typing (was 300ms)
  MUTATIONS: 1000,    // Wait 1s after mutations stop (was 300ms)
  SAVES: 1500,        // Wait 1.5s between save operations (was 500ms)
  BULK_SAVE: 2000,    // Wait 2s for bulk operations (was 1000ms)
  TITLE_SYNC: 500,
};

// ================================================================
// SAVE QUEUE CLASS
// ================================================================

export class SaveQueue {
  constructor(bookId = null) {
    this.bookId = bookId;
    this._fullVerifyTimer = null;
    // Track what needs to be saved
    this.pendingSaves = {
      nodes: new Map(),
      deletions: new Set(),
      lastActivity: null
    };

    // 🔑 CRITICAL: Track save completion for proper close handling
    this.currentSavePromise = null;

    // Self-healing & paste guard state
    this._selfHealingInProgress = false;
    this._forceBypassPasteGuard = false;
    this._pasteGuardDeferrals = 0;

    // ✅ REMOVED: ensureMinimumStructure callback - no longer needed with no-delete-id marker system

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
  queueNode(IDnumerical, action = 'update', bookId = null) {
    verbose.content(`SaveQueue.queueNode: ${IDnumerical}, action: ${action}, bookId: ${bookId || '(inherit)'}, pending: ${this.pendingSaves.nodes.size}`, 'divEditor/saveQueue.js');
    this.pendingSaves.nodes.set(IDnumerical, { id: IDnumerical, action, bookId });
    this.pendingSaves.lastActivity = Date.now();

    // Reset full-verification timer so it can't fire while saves are pending.
    // It will be rescheduled after the next save completes (_verifyAfterSave → _scheduleFullVerification).
    if (this._fullVerifyTimer) {
      clearTimeout(this._fullVerifyTimer);
      this._fullVerifyTimer = null;
    }

    // Dismiss large-paste undo toast on any subsequent edit
    hidePasteUndoToast();
    clearPasteSnapshot();

    verbose.content(`Calling debouncedSaveNode`, 'divEditor/saveQueue.js');
    this.debouncedSaveNode();
  }

  /**
   * Add node to pending deletions queue
   * Captures data-node-id and bookId from DOM before element is removed
   * @param {string} IDnumerical - The numeric DOM id="" value
   * @param {HTMLElement} [nodeElement] - Optional: the removed node element (has attributes even when removed from DOM)
   * @param {string} [explicitBookId] - Optional: explicit bookId (for sub-books where element is detached from DOM)
   */
   queueDeletion(IDnumerical, nodeElement = null, explicitBookId = null) {
    // ✅ FIX: Capture data-node-id - prefer passed element, fallback to DOM lookup
    const element = nodeElement || document.getElementById(IDnumerical);
    const dataNodeID = element?.getAttribute('data-node-id');

    // ✅ FIX: Determine bookId - use explicit if provided, else find from context
    let finalBookId = explicitBookId;
    if (!finalBookId) {
      if (element) {
        // Check element's closest sub-book container
        const subBookEl = element.closest('[data-book-id]');
        if (subBookEl) {
          finalBookId = subBookEl.dataset.bookId;
        }
      }
      // Fallback to main content if not found
      if (!finalBookId) {
        const mainContent = document.querySelector('.main-content');
        finalBookId = mainContent?.id || this.bookId || 'latest';
      }
    }

    // Store both IDnumerical and {dataNodeId, bookId} in a Map instead of Set
    if (!this.pendingSaves.deletionMap) {
      this.pendingSaves.deletionMap = new Map();
    }
    this.pendingSaves.deletionMap.set(IDnumerical, { dataNodeId: dataNodeID, bookId: finalBookId });

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

    verbose.content(`Queued node ${IDnumerical} for deletion (data-node-id: ${dataNodeID}${nodeElement ? ' from element' : ' from DOM'})`, 'divEditor/saveQueue.js');
    this.debouncedBatchDelete();
  }

  /**
   * Save queued nodes to database
   */
  async saveNodeToDatabase() {
    verbose.content(`saveNodeToDatabase called, pending nodes: ${this.pendingSaves.nodes.size}`, 'divEditor/saveQueue.js');
    if (this.pendingSaves.nodes.size === 0) {
      verbose.content('saveNodeToDatabase: no pending nodes, returning', 'divEditor/saveQueue.js');
      return;
    }

    // Paste guard: defer saves while paste is restructuring the DOM
    if (isPasteOperationActive() && !this._forceBypassPasteGuard) {
      this._pasteGuardDeferrals++;
      if (this._pasteGuardDeferrals > 10) {
        console.warn('[SaveQueue] Paste guard exceeded max deferrals — saving anyway');
        this._pasteGuardDeferrals = 0;
      } else {
        verbose.content(`[SaveQueue] Paste in progress — deferring save (attempt ${this._pasteGuardDeferrals})`, 'divEditor/saveQueue.js');
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
    verbose.content(`saveNodeToDatabase: processing ${nodesToSave.length} nodes`, 'divEditor/saveQueue.js');
    this.pendingSaves.nodes.clear();

    verbose.content(`Processing ${nodesToSave.length} pending node saves`, 'divEditor/saveQueue.js');

    const updates = nodesToSave.filter(n => n.action === 'update');
    const additions = nodesToSave.filter(n => n.action === 'add');
    const deletions = nodesToSave.filter(n => n.action === 'delete');

    // 🔑 CRITICAL: Create save operation promise for completion tracking
    this.currentSavePromise = (async () => {
      try {
        const recordsToUpdate = [...updates, ...additions].filter(node => {
          const element = document.getElementById(node.id);
          if (!element) {
            console.warn(`⚠️ Skipping save for node ${node.id} - element not found in DOM`);
            return false;
          }
          return true;
        });

        if (recordsToUpdate.length > 0) {
          verbose.content(`saveNodeToDatabase: saving ${recordsToUpdate.length} records to IndexedDB`, 'divEditor/saveQueue.js');

          // Group records by bookId for correct sub-book saves
          const recordsByBookId = new Map();
          for (const record of recordsToUpdate) {
            const effectiveBookId = record.bookId || this.bookId || null;
            if (!recordsByBookId.has(effectiveBookId)) {
              recordsByBookId.set(effectiveBookId, []);
            }
            recordsByBookId.get(effectiveBookId).push(record);
          }

          for (const [bookId, records] of recordsByBookId) {
            await batchUpdateIndexedDBRecords(records, bookId ? { bookId } : {});
          }

          verbose.content('saveNodeToDatabase: IndexedDB save complete', 'divEditor/saveQueue.js');
          reportIDBSuccess();
          // ✅ Mark cache dirty after successful saves
          markCacheDirty();
          // ✅ Invalidate search index so next search reflects edits
          invalidateSearchIndex();
          // ✅ Notify other tabs that this book was edited
          {
            const editedBooks = new Set();
            for (const [bk] of recordsByBookId) {
              editedBooks.add(bk || currentBook);
            }
            for (const bk of editedBooks) {
              if (bk) {
                const bc = new BroadcastChannel('hyperlit-tab-coordination');
                bc.postMessage({ type: 'BOOK_EDITED', book: bk, tabId: TAB_ID });
                bc.close();
              }
            }
          }
          // Non-blocking integrity verification after successful save
          this._verifyAfterSave(recordsByBookId);
        } else {
          verbose.content('saveNodeToDatabase: no records to update (elements not found in DOM)', 'divEditor/saveQueue.js');
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
  async processBatchDeletions() {
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
    const deletionDataMap = this.pendingSaves.deletionMap || new Map();

    // ✅ FIX: Group node IDs by bookId for correct deletion
    const nodesByBookId = new Map();
    nodeIdsToDelete.forEach(nodeId => {
      const deletionData = deletionDataMap.get(nodeId);
      const bookId = deletionData?.bookId || this.bookId || 'latest';
      if (!nodesByBookId.has(bookId)) {
        nodesByBookId.set(bookId, []);
      }
      nodesByBookId.get(bookId).push(nodeId);
    });

    // ✅ FIX: Create deletionMap for each book group (containing only data-node-ids)
    const buildDeletionMapForBook = (nodeIds, bookId) => {
      const map = new Map();
      nodeIds.forEach(nodeId => {
        const data = deletionDataMap.get(nodeId);
        map.set(nodeId, data?.dataNodeId || null);
      });
      return map;
    };

    // ✅ OPTIMIZATION: Log data-node-id capture rate (verbose mode)
    const dataNodeIDCount = Array.from(deletionDataMap.values()).filter(v => v?.dataNodeId).length;
    verbose.content(`DATA-NODE-ID CAPTURE: ${dataNodeIDCount}/${nodeIdsToDelete.length} nodes have data-node-ids (${((dataNodeIDCount/nodeIdsToDelete.length)*100).toFixed(1)}%)`, 'divEditor/saveQueue.js');
    verbose.content(`BOOK GROUPS: ${nodesByBookId.size} books with nodes to delete`, 'divEditor/saveQueue.js');

    this.pendingSaves.deletions.clear();
    this.pendingSaves.deletionMap = new Map(); // Clear the map

    verbose.content(`Batch deleting ${nodeIdsToDelete.length} nodes`, 'divEditor/saveQueue.js');

    try {
      // ✅ FIX: Process deletions grouped by bookId
      for (const [bookId, nodeIds] of nodesByBookId) {
        const bookDeletionMap = buildDeletionMapForBook(nodeIds, bookId);
        await batchDeleteIndexedDBRecords(nodeIds, bookDeletionMap, bookId);
        verbose.content(`Batch deleted ${nodeIds.length} nodes from book ${bookId}`, 'divEditor/saveQueue.js');
      }

      reportIDBSuccess();
      // ✅ Notify other tabs that this book was edited (deletions)
      {
        const editedBooks = new Set();
        for (const [bk] of nodesByBookId) {
          editedBooks.add(bk || currentBook);
        }
        for (const bk of editedBooks) {
          if (bk) {
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
      verbose.content('Cleared chunk loading flags - lazy loading re-enabled', 'divEditor/saveQueue.js');

      // ✅ Mark cache dirty so it refreshes before next chunk load
      markCacheDirty();
      // ✅ Invalidate search index so next search reflects deletions
      invalidateSearchIndex();
    }
  }

  /**
   * Non-blocking post-save integrity verification.
   * Runs in requestIdleCallback so it never blocks typing.
   */
  _verifyAfterSave(recordsByBookId) {
    const schedule = typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn, { timeout: 3000 })
      : (fn) => setTimeout(fn, 100);

    schedule(async () => {
      try {
        for (const [bookId, records] of recordsByBookId) {
          const effectiveBookId = bookId || currentBook;
          if (!effectiveBookId) continue;

          const nodeIds = records.map(r => r.id).filter(Boolean)
              .filter(id => !this.pendingSaves.nodes.has(id));
          if (nodeIds.length === 0) continue;

          const result = await verifyNodesIntegrity(effectiveBookId, nodeIds);

          const failedIds = [
            ...result.missingFromIDB.map(m => typeof m === 'object' ? m.nodeId : m),
            ...result.mismatches.map(m => m.nodeId),
          ];

          if (failedIds.length > 0 && !this._selfHealingInProgress) {
            // Attempt self-healing: re-queue failed nodes → flush → re-verify
            verbose.content(`[integrity] Post-save self-healing: re-queuing ${failedIds.length} nodes`, 'divEditor/saveQueue.js');
            this._selfHealingInProgress = true;
            try {
              // Don't overwrite IDB with empty DOM — that's data destruction
              const safeToHeal = failedIds.filter(id => {
                const m = result.mismatches.find(m => m.nodeId === id);
                if (m && !m.domText.trim() && m.idbText.trim()) {
                  console.warn(`[integrity] Skipping self-heal for node ${id}: DOM empty but IDB has "${m.idbText.substring(0, 50)}"`);
                  return false;
                }
                return true;
              });
              for (const id of safeToHeal) {
                this.queueNode(id, 'update', effectiveBookId);
              }
              await this.flush();
              const retryResult = await verifyNodesIntegrity(effectiveBookId, nodeIds);
              if (retryResult.mismatches.length > 0 || retryResult.missingFromIDB.length > 0 || retryResult.duplicateIds.length > 0) {
                reportIntegrityFailure({
                  bookId: effectiveBookId,
                  mismatches: retryResult.mismatches,
                  missingFromIDB: retryResult.missingFromIDB,
                  duplicateIds: retryResult.duplicateIds,
                  trigger: 'save',
                });
              } else {
                verbose.content(`[integrity] Post-save self-healing succeeded for ${failedIds.length} nodes`, 'divEditor/saveQueue.js');
                reportIntegrityFailure({
                  bookId: effectiveBookId,
                  mismatches: result.mismatches,
                  missingFromIDB: result.missingFromIDB,
                  duplicateIds: result.duplicateIds,
                  trigger: 'save',
                  selfHealed: true,
                  selfHealedNodeIds: failedIds,
                });
              }
            } finally {
              this._selfHealingInProgress = false;
            }
          } else if (result.duplicateIds.length > 0 || this._selfHealingInProgress) {
            // Can't self-heal duplicates or already healing — report immediately
            reportIntegrityFailure({
              bookId: effectiveBookId,
              mismatches: result.mismatches,
              missingFromIDB: result.missingFromIDB,
              duplicateIds: result.duplicateIds,
              trigger: 'save',
            });
          }

          // Schedule a full-book scan on a longer debounce
          this._scheduleFullVerification(effectiveBookId);
        }
      } catch (e) {
        console.warn('[integrity] Post-save verification error:', e);
      }
    });
  }

  /**
   * Schedule a full-book verification that scans ALL visible nodes against IDB.
   * Debounced at 10s after the last save settles, runs in requestIdleCallback.
   */
  _scheduleFullVerification(bookId) {
    if (this._fullVerifyTimer) clearTimeout(this._fullVerifyTimer);
    this._fullVerifyTimer = setTimeout(() => {
      this._fullVerifyTimer = null;
      const schedule = typeof requestIdleCallback === 'function'
        ? (fn) => requestIdleCallback(fn, { timeout: 5000 })
        : (fn) => setTimeout(fn, 200);

      schedule(async () => {
        const container = document.querySelector(`[data-book-id="${bookId}"]`)
          || document.getElementById(bookId);
        if (!container) return;

        const nodeEls = container.querySelectorAll('[id]');
        const nodeIds = [];
        nodeEls.forEach(el => {
          if (/^\d+(\.\d+)?$/.test(el.id)) nodeIds.push(el.id);
        });
        if (nodeIds.length === 0) return;

        try {
          verbose.content(`[integrity] Full-book verification: checking ${nodeIds.length} nodes for ${bookId}`, 'divEditor/saveQueue.js');
          const result = await verifyNodesIntegrity(bookId, nodeIds);

          const failedIds = [
            ...result.missingFromIDB.map(m => typeof m === 'object' ? m.nodeId : m),
            ...result.mismatches.map(m => m.nodeId),
          ];

          if (failedIds.length > 0 && !this._selfHealingInProgress) {
            verbose.content(`[integrity] Full-scan self-healing: re-queuing ${failedIds.length} nodes`, 'divEditor/saveQueue.js');
            this._selfHealingInProgress = true;
            try {
              // Don't overwrite IDB with empty DOM — that's data destruction
              const safeToHeal = failedIds.filter(id => {
                const m = result.mismatches.find(m => m.nodeId === id);
                if (m && !m.domText.trim() && m.idbText.trim()) {
                  console.warn(`[integrity] Skipping self-heal for node ${id}: DOM empty but IDB has "${m.idbText.substring(0, 50)}"`);
                  return false;
                }
                return true;
              });
              for (const id of safeToHeal) {
                this.queueNode(id, 'update', bookId);
              }
              await this.flush();
              const retryResult = await verifyNodesIntegrity(bookId, nodeIds);
              if (retryResult.mismatches.length > 0 || retryResult.missingFromIDB.length > 0 || retryResult.duplicateIds.length > 0) {
                reportIntegrityFailure({
                  bookId,
                  mismatches: retryResult.mismatches,
                  missingFromIDB: retryResult.missingFromIDB,
                  duplicateIds: retryResult.duplicateIds,
                  trigger: 'periodic-save',
                });
              } else {
                verbose.content(`[integrity] Full-scan self-healing succeeded for ${failedIds.length} nodes`, 'divEditor/saveQueue.js');
                reportIntegrityFailure({
                  bookId,
                  mismatches: result.mismatches,
                  missingFromIDB: result.missingFromIDB,
                  duplicateIds: result.duplicateIds,
                  trigger: 'periodic-save',
                  selfHealed: true,
                  selfHealedNodeIds: failedIds,
                });
              }
            } finally {
              this._selfHealingInProgress = false;
            }
          } else if (result.duplicateIds.length > 0 || this._selfHealingInProgress) {
            reportIntegrityFailure({
              bookId,
              mismatches: result.mismatches,
              missingFromIDB: result.missingFromIDB,
              duplicateIds: result.duplicateIds,
              trigger: 'periodic-save',
            });
          } else {
            verbose.content(`[integrity] Full-book verification: all ${result.ok.length} nodes OK`, 'divEditor/saveQueue.js');
          }
        } catch (e) {
          console.warn('[integrity] Full-book verification error:', e);
        }
      });
    }, 10_000);
  }

  /**
   * Force save all pending changes immediately
   */
  async flush() {
    verbose.content('Flushing all pending saves...', 'divEditor/saveQueue.js');

    // Clear debounce timers and execute immediately
    this.debouncedSaveNode.cancel();
    this.debouncedBatchDelete.cancel();

    // 🔑 CRITICAL: Wait for any ongoing save to complete first
    if (this.currentSavePromise) {
      verbose.content('[SaveQueue] Waiting for ongoing save to complete...', 'divEditor/saveQueue.js');
      await this.currentSavePromise;
      verbose.content('[SaveQueue] Ongoing save completed', 'divEditor/saveQueue.js');
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
        verbose.content('[SaveQueue] Waiting for final save to complete...', 'divEditor/saveQueue.js');
        await this.currentSavePromise;
        verbose.content('[SaveQueue] Final save completed', 'divEditor/saveQueue.js');
      }
    } finally {
      this._forceBypassPasteGuard = false;
    }

    verbose.content('SaveQueue flush complete', 'divEditor/saveQueue.js');
  }

  /**
   * Check if there are pending operations
   */
  get hasPending() {
    return this.pendingSaves.nodes.size > 0 || this.pendingSaves.deletions.size > 0;
  }

  /**
   * Start monitoring pending saves (for debugging)
   */
  startMonitoring() {
    if (this.monitor) {
      clearInterval(this.monitor);
    }

    this.monitor = setInterval(() => {
      const now = Date.now();
      const timeSinceLastActivity = this.pendingSaves.lastActivity
        ? now - this.pendingSaves.lastActivity
        : null;

      if (this.hasPending) {
        verbose.content(`Pending saves: ${this.pendingSaves.nodes.size} nodes, ${this.pendingSaves.deletions.size} deletions (${timeSinceLastActivity}ms since last activity)`, 'divEditor/saveQueue.js');
      }
    }, 5000);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = null;
      verbose.content("Pending saves monitor stopped", 'divEditor/saveQueue.js');
    }
  }

  /**
   * Cleanup and cancel all pending operations
   */
  destroy() {
    this.debouncedSaveNode.cancel();
    this.debouncedBatchDelete.cancel();
    if (this._fullVerifyTimer) {
      clearTimeout(this._fullVerifyTimer);
      this._fullVerifyTimer = null;
    }
    this.stopMonitoring();
    this.pendingSaves.nodes.clear();
    this.pendingSaves.deletions.clear();
  }
}
