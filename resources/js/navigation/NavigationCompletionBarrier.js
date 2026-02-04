/**
 * NavigationCompletionBarrier - Coordinates multiple async processes during navigation
 *
 * Ensures navigation flags (isNavigatingToInternalId, pendingNavigationTarget) persist
 * until ALL async processes complete, preventing race conditions where background
 * timestamp checks trigger refresh() after flags have been cleared.
 *
 * Design Principles:
 * 1. Process Registration - Async operations register themselves before starting
 * 2. Completion Signaling - Each process signals when done
 * 3. Barrier Release - Only when ALL registered processes complete do flags clear
 * 4. Safety Timeout - Force cleanup after 10 seconds to prevent stuck state
 *
 * State Machine:
 *   'idle'    -> No active navigation
 *   'waiting' -> Navigation active, waiting for processes
 *   'cleanup' -> All processes done, cleanup in progress
 */

import { verbose } from '../utilities/logger.js';

export const NavigationProcess = {
  SCROLL_COMPLETE: 'scroll_complete',           // Navigation scroll finished
  SCROLL_CORRECTION: 'scroll_correction',       // Post-scroll position correction (0-500ms)
  TIMESTAMP_CHECK: 'timestamp_check',           // checkAndUpdateIfNeeded() server request
  CONTENT_REFRESH: 'content_refresh'            // lazyLoader.refresh() if needed
};

export class NavigationCompletionBarrier {
  // State machine
  static state = 'idle';  // 'idle' | 'waiting' | 'cleanup'

  // Navigation context
  static targetId = null;
  static lazyLoader = null;

  // Registered processes
  static registeredProcesses = new Map();

  // Completion promise (for callers waiting on full completion)
  static completionPromise = null;
  static completionResolver = null;

  // Timeout safety net
  static safetyTimeout = null;
  static SAFETY_TIMEOUT_MS = 10000; // 10 seconds max

  // User abort flag
  static userAborted = false;

  /**
   * Start a new navigation barrier session
   * @param {string} targetId - Navigation target element ID
   * @param {object} lazyLoader - LazyLoader instance
   * @returns {Promise} - Resolves when ALL processes complete
   */
  static startNavigation(targetId, lazyLoader) {
    // If navigation already in progress, abort it first
    if (this.state !== 'idle') {
      console.log('⚠️ NavigationCompletionBarrier: New navigation requested, aborting previous');
      this._forceCleanup();
    }

    console.log(`🚦 NavigationCompletionBarrier: Starting barrier for ${targetId}`);

    // Initialize state
    this.state = 'waiting';
    this.targetId = targetId;
    this.lazyLoader = lazyLoader;
    this.userAborted = false;
    this.registeredProcesses.clear();

    // Create completion promise
    this.completionPromise = new Promise(resolve => {
      this.completionResolver = resolve;
    });

    // Start safety timeout
    this._startSafetyTimeout();

    return this.completionPromise;
  }

  /**
   * Register a process that must complete before cleanup
   * @param {string} processType - From NavigationProcess enum
   */
  static registerProcess(processType) {
    if (this.state === 'idle') {
      console.warn(`⚠️ NavigationCompletionBarrier: Cannot register ${processType} - no active navigation`);
      return;
    }

    if (this.registeredProcesses.has(processType)) {
      verbose.debug(`NavigationCompletionBarrier: ${processType} already registered`, 'NavigationCompletionBarrier.js');
      return;
    }

    this.registeredProcesses.set(processType, {
      status: 'pending',
      registeredAt: Date.now()
    });

    console.log(`📝 NavigationCompletionBarrier: Registered ${processType} (${this.registeredProcesses.size} total)`);
  }

  /**
   * Signal that a process has completed
   * @param {string} processType - Which process completed
   * @param {boolean} success - Whether it succeeded
   */
  static completeProcess(processType, success = true) {
    if (this.state === 'idle') {
      verbose.debug(`NavigationCompletionBarrier: Ignoring completion of ${processType} - no active navigation`, 'NavigationCompletionBarrier.js');
      return;
    }

    const process = this.registeredProcesses.get(processType);
    if (!process) {
      verbose.debug(`NavigationCompletionBarrier: ${processType} was not registered, ignoring`, 'NavigationCompletionBarrier.js');
      return;
    }

    if (process.status !== 'pending') {
      verbose.debug(`NavigationCompletionBarrier: ${processType} already completed, ignoring`, 'NavigationCompletionBarrier.js');
      return;
    }

    process.status = success ? 'complete' : 'failed';
    process.completedAt = Date.now();

    const pendingCount = this._getPendingCount();
    console.log(`✅ NavigationCompletionBarrier: ${processType} ${success ? 'completed' : 'failed'} (${pendingCount} remaining)`);

    // Check if all processes are done
    if (pendingCount === 0) {
      this._performCleanup();
    }
  }

  /**
   * Check if navigation barrier is currently active
   * @returns {boolean}
   */
  static isNavigating() {
    return this.state !== 'idle';
  }

  /**
   * Get the current navigation target
   * Used by refresh() to know where to scroll
   * @returns {string|null}
   */
  static getNavigationTarget() {
    return this.targetId;
  }

  /**
   * Abort navigation (e.g., user scrolled during navigation)
   */
  static abort() {
    if (this.state === 'idle') return;

    console.log('🚫 NavigationCompletionBarrier: Aborted by user');
    this.userAborted = true;
    this._forceCleanup();
  }

  /**
   * Get the number of pending processes
   * @private
   */
  static _getPendingCount() {
    let count = 0;
    for (const process of this.registeredProcesses.values()) {
      if (process.status === 'pending') count++;
    }
    return count;
  }

  /**
   * Check if all processes have completed (success or failure)
   * @private
   */
  static _allProcessesComplete() {
    for (const process of this.registeredProcesses.values()) {
      if (process.status === 'pending') return false;
    }
    return true;
  }

  /**
   * Start the safety timeout
   * @private
   */
  static _startSafetyTimeout() {
    this._clearSafetyTimeout();

    this.safetyTimeout = setTimeout(() => {
      if (this.state !== 'idle') {
        console.warn('⚠️ NavigationCompletionBarrier: Safety timeout triggered');

        // Log which processes didn't complete
        for (const [type, process] of this.registeredProcesses) {
          if (process.status === 'pending') {
            const elapsed = Date.now() - process.registeredAt;
            console.warn(`  - ${type}: still pending after ${elapsed}ms`);
          }
        }

        this._forceCleanup();
      }
    }, this.SAFETY_TIMEOUT_MS);
  }

  /**
   * Clear the safety timeout
   * @private
   */
  static _clearSafetyTimeout() {
    if (this.safetyTimeout) {
      clearTimeout(this.safetyTimeout);
      this.safetyTimeout = null;
    }
  }

  /**
   * Perform cleanup when all processes complete
   * @private
   */
  static _performCleanup() {
    if (this.state === 'cleanup' || this.state === 'idle') return;

    console.log('🧹 NavigationCompletionBarrier: All processes complete, performing cleanup');
    this.state = 'cleanup';

    this._clearSafetyTimeout();

    // Clear navigation flags on lazyLoader
    if (this.lazyLoader) {
      this.lazyLoader.isNavigatingToInternalId = false;
      this.lazyLoader.pendingNavigationTarget = null;

      // Unlock scroll if locked
      if (this.lazyLoader.unlockScroll) {
        this.lazyLoader.unlockScroll();
      }
    }

    // Check for any failures
    const hasFailures = Array.from(this.registeredProcesses.values())
      .some(p => p.status === 'failed');

    // Resolve completion promise
    if (this.completionResolver) {
      this.completionResolver({
        success: !hasFailures && !this.userAborted,
        targetId: this.targetId,
        aborted: this.userAborted,
        processes: Object.fromEntries(this.registeredProcesses)
      });
    }

    // Reset state
    this._reset();

    console.log('✅ NavigationCompletionBarrier: Cleanup complete, state reset to idle');
  }

  /**
   * Force cleanup immediately (for abort or timeout)
   * @private
   */
  static _forceCleanup() {
    // Mark all pending processes as failed
    for (const process of this.registeredProcesses.values()) {
      if (process.status === 'pending') {
        process.status = 'failed';
        process.completedAt = Date.now();
      }
    }

    this._performCleanup();
  }

  /**
   * Reset all state to initial values
   * @private
   */
  static _reset() {
    this.state = 'idle';
    this.targetId = null;
    this.lazyLoader = null;
    this.registeredProcesses.clear();
    this.completionPromise = null;
    this.completionResolver = null;
    this.userAborted = false;
  }

  /**
   * Debug method - logs current state
   */
  static debug() {
    console.log('📊 NavigationCompletionBarrier Debug:', {
      state: this.state,
      targetId: this.targetId,
      processes: Object.fromEntries(this.registeredProcesses),
      pendingCount: this._getPendingCount()
    });
  }
}

// Expose to window for debugging
if (typeof window !== 'undefined') {
  window.NavigationCompletionBarrier = NavigationCompletionBarrier;
  window.debugNavigationBarrier = () => NavigationCompletionBarrier.debug();
}
