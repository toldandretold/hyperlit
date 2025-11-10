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

// ================================================================
// DEBOUNCING INFRASTRUCTURE
// ================================================================

// Debounce delays (in milliseconds)
const DEBOUNCE_DELAYS = {
  TYPING: 300,        // Wait 300ms after user stops typing
  MUTATIONS: 300,     // Wait 300ms after mutations stop
  SAVES: 500,         // Wait 500ms between save operations
  BULK_SAVE: 1000,    // Wait 1s for bulk operations
  TITLE_SYNC: 500,
};

/**
 * Creates a debounced function that delays invoking `func` until after `delay`
 * milliseconds have passed since the last time the debounced function was invoked.
 *
 * Includes `.cancel()` and `.flush()` methods.
 */
export function debounce(func, delay) {
  let timeoutId;
  let lastArgs;
  let lastThis;

  const debouncedFunction = function (...args) {
    lastThis = this;
    lastArgs = args;
    clearTimeout(timeoutId);

    timeoutId = setTimeout(() => {
      func.apply(lastThis, lastArgs);
      timeoutId = null;
    }, delay);
  };

  debouncedFunction.cancel = function () {
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  debouncedFunction.flush = function () {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
      func.apply(lastThis, lastArgs);
    }
  };

  return debouncedFunction;
}

// ================================================================
// SAVE QUEUE CLASS
// ================================================================

export class SaveQueue {
  constructor(ensureMinimumStructureFn) {
    // Track what needs to be saved
    this.pendingSaves = {
      nodes: new Map(),
      deletions: new Set(),
      lastActivity: null
    };

    // Store the structure function for deletion callbacks
    this.ensureMinimumStructure = ensureMinimumStructureFn;

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

    console.log(`📝 Queued node ${nodeId} for ${action}`);
    this.debouncedSaveNode();
  }

  /**
   * Add node to pending deletions queue
   */
  queueDeletion(nodeId) {
    this.pendingSaves.deletions.add(nodeId);
    this.pendingSaves.lastActivity = Date.now();

    console.log(`🗑️ Queued node ${nodeId} for deletion`);
    this.debouncedBatchDelete();
  }

  /**
   * Save queued nodes to database
   */
  async saveNodeToDatabase() {
    if (this.pendingSaves.nodes.size === 0) return;

    const nodesToSave = Array.from(this.pendingSaves.nodes.values());
    this.pendingSaves.nodes.clear();

    console.log(`💾 Processing ${nodesToSave.length} pending node saves`);

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
      }

      if (deletions.length > 0) {
        await Promise.all(deletions.map(node =>
          deleteIndexedDBRecordWithRetry(node.id)
        ));
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
    this.pendingSaves.deletions.clear();

    console.log(`🗑️ Batch deleting ${nodeIdsToDelete.length} nodes`);

    try {
      await batchDeleteIndexedDBRecords(nodeIdsToDelete);
      console.log(`✅ Batch deleted ${nodeIdsToDelete.length} nodes`);

      // Check if we need to restore minimum structure
      setTimeout(() => {
        const pasteActive = isPasteOperationActive();
        console.log(`🔍 [BATCH DELETE] Checking structure after batch delete. Paste active: ${pasteActive}`);
        if (!pasteActive && this.ensureMinimumStructure) {
          console.log(`🔧 [BATCH DELETE] Calling ensureMinimumDocumentStructure()`);
          this.ensureMinimumStructure();
        } else {
          console.log(`⏸️ [BATCH DELETE] Skipping structure check - paste in progress`);
        }
      }, 100);
    } catch (error) {
      console.error('❌ Error in batch deletion:', error);
      // Re-queue failed deletions
      nodeIdsToDelete.forEach(id => this.pendingSaves.deletions.add(id));
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
        console.log(`📊 Pending saves: ${this.pendingSaves.nodes.size} nodes, ${this.pendingSaves.deletions.size} deletions (${timeSinceLastActivity}ms since last activity)`);
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
      console.log("📊 Pending saves monitor stopped");
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
