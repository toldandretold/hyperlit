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
import { pendingSyncs, debouncedMasterSync } from "../indexedDB/index.js";
import { currentLazyLoader } from "../initializePage.js";

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

      const targetId = await undoLastBatch();

      if (targetId && currentLazyLoader) {
        await currentLazyLoader.refresh(targetId);
      } else if (targetId) {
        window.location.reload();
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
      const targetId = await redoLastBatch();

      if (targetId && currentLazyLoader) {
        await currentLazyLoader.refresh(targetId);
      } else if (targetId) {
        window.location.reload();
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
    console.log("Updating history button states...");

    // RE-ACQUIRE REFERENCES TO THE BUTTONS
    // This is vital because the DOM might have been rebuilt by lazyLoaderFactory.refresh()
    this.undoButton = document.getElementById("undoButton");
    this.redoButton = document.getElementById("redoButton");

    if (this.undoButton) {
      const canCurrentlyUndo = await canUndo();
      console.log(
        `Undo button: isProcessingHistory=${this.isProcessingHistory}, canCurrentlyUndo=${canCurrentlyUndo}`
      );
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
      console.log(
        `Redo button: isProcessingHistory=${this.isProcessingHistory}, canCurrentlyRedo=${canCurrentlyRedo}`
      );
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
