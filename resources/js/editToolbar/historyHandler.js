/**
 * History Handler for EditToolbar
 *
 * Manages undo/redo operations and history button states.
 * Handles the locking mechanism to prevent concurrent history operations.
 */

import {
  undoLastBatch,
  redoLastBatch,
  canUndo,
  canRedo,
} from "../historyManager.js";
import { pendingSyncs, debouncedMasterSync, executeSyncPayload } from "../indexedDB/index.js";
import { currentLazyLoader } from "../initializePage.js";
import { log, verbose } from "../utilities/logger.js";
import { glowCloudOrange, glowCloudGreen, glowCloudRed } from "../components/editIndicator.js";

/**
 * Sync undo/redo changes directly to PostgreSQL WITHOUT creating history entries.
 * Uses executeSyncPayload directly instead of debouncedMasterSync.
 *
 * History is already managed by undoLastBatch/redoLastBatch which move entries
 * between historyLog and redoLog. We just need to sync to PostgreSQL.
 *
 * Important: Only delete items that were NEWLY CREATED in the original operation.
 * Modified items appear in both restored and deleted arrays - we just need to
 * sync the restored version, not delete them.
 */
async function syncUndoRedoToPostgreSQL(undoResult) {
  if (!undoResult) return;

  const {
    restoredNodes = [],
    restoredHyperlights = [],
    restoredHypercites = [],
    restoredLibrary = null,
    deletedNodes = [],
    deletedHyperlights = [],
    deletedHypercites = [],
  } = undoResult;

  // Build sets of restored IDs to check for truly new items
  const restoredNodeIds = new Set(restoredNodes.map(n => n.node_id || n.startLine));
  const restoredHyperlightIds = new Set(restoredHyperlights.map(h => h.hyperlight_id));
  const restoredHyperciteIds = new Set(restoredHypercites.map(h => h.hyperciteId));

  // Get book ID from the data
  const bookId = restoredNodes[0]?.book ||
                 deletedNodes[0]?.book ||
                 restoredHyperlights[0]?.book ||
                 restoredLibrary?.book ||
                 window.book;

  if (!bookId) {
    console.warn("⚠️ No book ID found for undo/redo sync");
    return;
  }

  // Build sync payload directly (bypassing pendingSyncs and history creation)
  const syncPayload = {
    book: bookId,
    updates: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], library: null },
    deletions: { nodes: [], hyperlights: [], hypercites: [] },
  };

  // Add restored nodes
  for (const node of restoredNodes) {
    syncPayload.updates.nodes.push(node);
  }

  // Only delete nodes that were NEWLY CREATED (not in restored set)
  let deletedNodeCount = 0;
  for (const node of deletedNodes) {
    const nodeId = node.node_id || node.startLine;
    if (!restoredNodeIds.has(nodeId)) {
      syncPayload.deletions.nodes.push({ ...node, _action: "delete" });
      deletedNodeCount++;
    }
  }

  // Add restored hyperlights
  for (const hl of restoredHyperlights) {
    syncPayload.updates.hyperlights.push(hl);
  }

  // Only delete hyperlights that were newly created
  let deletedHyperlightCount = 0;
  for (const hl of deletedHyperlights) {
    if (!restoredHyperlightIds.has(hl.hyperlight_id)) {
      syncPayload.deletions.hyperlights.push({ ...hl, _action: "delete" });
      deletedHyperlightCount++;
    }
  }

  // Add restored hypercites
  for (const hc of restoredHypercites) {
    syncPayload.updates.hypercites.push(hc);
  }

  // Only delete hypercites that were newly created
  let deletedHyperciteCount = 0;
  for (const hc of deletedHypercites) {
    if (!restoredHyperciteIds.has(hc.hyperciteId)) {
      syncPayload.deletions.hypercites.push({ ...hc, _action: "delete" });
      deletedHyperciteCount++;
    }
  }

  // Add restored library
  if (restoredLibrary) {
    syncPayload.updates.library = restoredLibrary;
  }

  const totalItems =
    restoredNodes.length +
    deletedNodeCount +
    restoredHyperlights.length +
    deletedHyperlightCount +
    restoredHypercites.length +
    deletedHyperciteCount +
    (restoredLibrary ? 1 : 0);

  if (totalItems > 0) {
    console.log(`📤 Syncing undo/redo to PostgreSQL: ${restoredNodes.length} restored nodes, ${deletedNodeCount} deleted nodes (no history entry)`);

    // Show orange indicator while syncing
    glowCloudOrange();

    try {
      await executeSyncPayload(syncPayload);
      console.log("✅ Undo/redo PostgreSQL sync complete");
      // Show green indicator on success
      glowCloudGreen();
    } catch (error) {
      console.error("❌ Undo/redo PostgreSQL sync failed:", error);
      // Show red indicator on error
      glowCloudRed();
    }
  }
}

/**
 * Helper function to yield to the browser's main thread.
 * Pauses execution and yields to the main thread, allowing the event loop
 * to process pending operations like IndexedDB commits.
 */
function yieldToMainThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * HistoryHandler class
 * Manages undo/redo functionality and button states
 */
export class HistoryHandler {
  constructor(options = {}) {
    this.undoButton = options.undoButton || null;
    this.redoButton = options.redoButton || null;
    this.isDisabled = options.isDisabled || false;

    // Lock to prevent concurrent undo/redo operations
    this.isProcessingHistory = false;

    // Bind methods
    this.handleUndo = this.handleUndo.bind(this);
    this.handleRedo = this.handleRedo.bind(this);
    this.updateHistoryButtonStates = this.updateHistoryButtonStates.bind(this);

    log.init('History handler initialized', '/editToolbar/historyHandler.js');
  }

  /**
   * Handle undo operation
   */
  async handleUndo() {
    if (this.isProcessingHistory) {
      console.log("⏳ Undo/Redo already in progress. Please wait.");
      return;
    }
    this.isProcessingHistory = true;
    this.updateHistoryButtonStates();

    try {
      if (pendingSyncs.size > 0) {
        console.log("🌀 Pending changes detected. Flushing sync before undoing...");
        await debouncedMasterSync.flush();
        console.log("✅ Flush complete.");
      }

      const undoResult = await undoLastBatch();

      // Handle genesis state - nothing more to undo
      if (undoResult && undoResult.reason === 'genesis') {
        console.log("🌱 At genesis state - nothing more to undo");
        return;
      }

      if (undoResult && undoResult.targetId !== undefined) {
        const { targetId, restoredNodes, deletedNodes } = undoResult;
        console.log("🔍 Undo result - restored:", restoredNodes?.length, "deleted:", deletedNodes?.length);
        console.log("🔍 Restored node IDs:", restoredNodes?.map(n => n.node_id || n.startLine));
        console.log("🔍 Deleted node IDs:", deletedNodes?.map(n => n.node_id || n.startLine));

        // Sync to PostgreSQL directly (no history entry creation)
        await syncUndoRedoToPostgreSQL(undoResult);

        if (targetId && currentLazyLoader) {
          await currentLazyLoader.refresh(targetId);
        } else if (targetId) {
          window.location.reload();
        }
      }
    } catch (error) {
      console.error("❌ Error during undo operation:", error);
    } finally {
      console.log("Yielding to main thread before releasing lock...");
      await yieldToMainThread();

      this.isProcessingHistory = false;
      this.updateHistoryButtonStates();
      console.log("✅ Undo/Redo lock released.");
    }
  }

  /**
   * Handle redo operation
   */
  async handleRedo() {
    if (this.isProcessingHistory) {
      console.log("⏳ Undo/Redo already in progress. Please wait.");
      return;
    }
    this.isProcessingHistory = true;
    this.updateHistoryButtonStates();

    try {
      const redoResult = await redoLastBatch();

      if (redoResult) {
        const { targetId } = redoResult;

        // Sync to PostgreSQL directly (no history entry creation)
        await syncUndoRedoToPostgreSQL(redoResult);

        if (targetId && currentLazyLoader) {
          await currentLazyLoader.refresh(targetId);
        } else if (targetId) {
          window.location.reload();
        }
      }
    } catch (error) {
      console.error("❌ Error during redo operation:", error);
    } finally {
      console.log("Yielding to main thread before releasing lock...");
      await yieldToMainThread();

      this.isProcessingHistory = false;
      this.updateHistoryButtonStates();
      console.log("✅ Undo/Redo lock released.");
    }
  }

  /**
   * Update the enabled/disabled states of history buttons
   */
  async updateHistoryButtonStates() {
    if (this.isDisabled) return;

    // RE-ACQUIRE REFERENCES TO THE BUTTONS
    // This is vital because the DOM might have been rebuilt by lazyLoaderFactory.refresh()
    this.undoButton = document.getElementById("undoButton");
    this.redoButton = document.getElementById("redoButton");

    if (this.undoButton) {
      const canCurrentlyUndo = await canUndo();
      this.undoButton.classList.toggle("processing", this.isProcessingHistory);
      this.undoButton.classList.toggle(
        "disabled",
        this.isProcessingHistory || !canCurrentlyUndo
      );
      this.undoButton.disabled =
        this.isProcessingHistory || !canCurrentlyUndo; // Disable button element
    } else {
      console.warn("Undo button not found in DOM.");
    }

    if (this.redoButton) {
      const canCurrentlyRedo = await canRedo();
      this.redoButton.classList.toggle("processing", this.isProcessingHistory);
      this.redoButton.classList.toggle(
        "disabled",
        this.isProcessingHistory || !canCurrentlyRedo
      );
      this.redoButton.disabled =
        this.isProcessingHistory || !canCurrentlyRedo; // Disable button element
    } else {
      console.warn("Redo button not found in DOM.");
    }
  }
}
