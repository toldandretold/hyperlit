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
  constructor() {
    // Track what needs to be saved
    this.pendingSaves = {
      nodes: new Map(),
      deletions: new Set(),
      lastActivity: null
    };

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
  queueNode(nodeId, action = 'update') {
    this.pendingSaves.nodes.set(nodeId, { id: nodeId, action });
    this.pendingSaves.lastActivity = Date.now();

    verbose.content(`Queued node ${nodeId} for ${action}`, 'divEditor/saveQueue.js');
    this.debouncedSaveNode();
  }

  /**
   * Add node to pending deletions queue
   * Captures UUID from DOM before element is removed
   * @param {string} nodeId - The node ID
   * @param {HTMLElement} [nodeElement] - Optional: the removed node element (has attributes even when removed from DOM)
   */
  queueDeletion(nodeId, nodeElement = null) {
    // ✅ NEW: Capture UUID - prefer passed element, fallback to DOM lookup
    const element = nodeElement || document.getElementById(nodeId);
    const nodeUUID = element?.getAttribute('data-node-id');

    // Store both nodeId and UUID in a Map instead of Set
    if (!this.pendingSaves.deletionMap) {
      this.pendingSaves.deletionMap = new Map();
    }
    this.pendingSaves.deletionMap.set(nodeId, nodeUUID);

    // Keep deletions Set for backward compatibility
    this.pendingSaves.deletions.add(nodeId);
    this.pendingSaves.lastActivity = Date.now();

    // ⚠️ DIAGNOSTIC: Log stack trace when deletion queue grows large
    if (this.pendingSaves.deletions.size === 11) {
      console.warn(`⚠️ DELETION QUEUE HIT 11 NODES - capturing stack`, {
        stack: new Error().stack,
        currentQueue: Array.from(this.pendingSaves.deletions),
        timestamp: Date.now()
      });
    }

    verbose.content(`Queued node ${nodeId} for deletion (UUID: ${nodeUUID}${nodeElement ? ' from element' : ' from DOM'})`, 'divEditor/saveQueue.js');
    this.debouncedBatchDelete();
  }

  /**
   * Save queued nodes to database
   */
  async saveNodeToDatabase() {
    if (this.pendingSaves.nodes.size === 0) return;

    const nodesToSave = Array.from(this.pendingSaves.nodes.values());
    this.pendingSaves.nodes.clear();

    verbose.content(`Processing ${nodesToSave.length} pending node saves`, 'divEditor/saveQueue.js');

    const updates = nodesToSave.filter(n => n.action === 'update');
    const additions = nodesToSave.filter(n => n.action === 'add');
    const deletions = nodesToSave.filter(n => n.action === 'delete');

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
        await batchUpdateIndexedDBRecords(recordsToUpdate);
        // ✅ Mark cache dirty after successful saves
        markCacheDirty();
        // ✅ Invalidate search index so next search reflects edits
        invalidateSearchIndex();
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
      // Re-queue failed saves
      nodesToSave.forEach(node => this.pendingSaves.nodes.set(node.id, node));
    }
  }

  /**
   * Process batch deletions from queue
   */
  async processBatchDeletions() {
    if (this.pendingSaves.deletions.size === 0) return;

    const nodeIdsToDelete = Array.from(this.pendingSaves.deletions);

    // ⚠️ DIAGNOSTIC: Log when many nodes are being batch deleted
    if (nodeIdsToDelete.length > 10) {
      console.warn(`⚠️ SAVE_QUEUE BATCH DELETE: ${nodeIdsToDelete.length} nodes`, {
        stack: new Error().stack,
        nodeIds: nodeIdsToDelete.slice(0, 10),
        timestamp: Date.now()
      });
    }

    // ✅ NEW: Get UUID map for deleted nodes
    const deletionMap = this.pendingSaves.deletionMap || new Map();

    // ✅ OPTIMIZATION: Log UUID capture rate (verbose mode)
    const uuidsCount = Array.from(deletionMap.values()).filter(Boolean).length;
    verbose.content(`UUID CAPTURE: ${uuidsCount}/${nodeIdsToDelete.length} nodes have UUIDs (${((uuidsCount/nodeIdsToDelete.length)*100).toFixed(1)}%)`, 'divEditor/saveQueue.js');

    this.pendingSaves.deletions.clear();
    this.pendingSaves.deletionMap = new Map(); // Clear the map

    verbose.content(`Batch deleting ${nodeIdsToDelete.length} nodes`, 'divEditor/saveQueue.js');

    try {
      await batchDeleteIndexedDBRecords(nodeIdsToDelete, deletionMap);
      verbose.content(`Batch deleted ${nodeIdsToDelete.length} nodes`, 'divEditor/saveQueue.js');

      // ✅ REMOVED: Legacy ensureMinimumDocumentStructure() call from old node-counting system
      // The no-delete-id marker system prevents document from becoming empty, so this is unnecessary
    } catch (error) {
      console.error('❌ Error in batch deletion:', error);
      // Re-queue failed deletions
      nodeIdsToDelete.forEach(id => this.pendingSaves.deletions.add(id));
    } finally {
      // ✅ Clear chunk loading flags to re-enable lazy loading
      clearChunkLoadingInProgress();
      console.log('🔓 Cleared chunk loading flags - lazy loading re-enabled');

      // ✅ Mark cache dirty so it refreshes before next chunk load
      markCacheDirty();
      // ✅ Invalidate search index so next search reflects deletions
      invalidateSearchIndex();
    }
  }

  /**
   * Force save all pending changes immediately
   */
  flush() {
    console.log('🚨 Flushing all pending saves...');

    // Clear debounce timers and execute immediately
    this.debouncedSaveNode.cancel();
    this.debouncedBatchDelete.cancel();

    if (this.pendingSaves.nodes.size > 0) {
      this.saveNodeToDatabase();
    }

    if (this.pendingSaves.deletions.size > 0) {
      this.processBatchDeletions();
    }
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
    this.stopMonitoring();
    this.pendingSaves.nodes.clear();
    this.pendingSaves.deletions.clear();
  }
}
