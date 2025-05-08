// operationState.js

import { showSpinner, showTick } from "./editIndicator.js";

let pendingOperations = 0;
let unloadWarningActive = false;

/**
 * Returns the current number of pending operations.
 */
export function getPendingOperations() {
  return pendingOperations;
}

/**
 * Returns whether the unload warning is active.
 */
export function getUnloadWarningActive() {
  return unloadWarningActive;
}

/**
 * Enable or disable the unload warning.
 */
export function setUnloadWarningActive(value) {
  unloadWarningActive = value;
  return unloadWarningActive;
}

/**
 * Internal helper: whenever pendingOperations changes,
 * if >0 show spinner, if it reaches 0 show tick.
 */
function notifySpinnerOrTick() {
  if (pendingOperations > 0) {
    showSpinner();
  } else {
    showTick();
  }
}

/**
 * Increment the pending-operations counter.
 * If going 0 → 1, trigger the spinner.
 */
export function incrementPendingOperations() {
  pendingOperations++;
  console.log("⏳ Pending operations:", pendingOperations);
  if (pendingOperations === 1) {
    notifySpinnerOrTick();
  }
  return pendingOperations;
}

/**
 * Decrement the pending-operations counter (never below 0).
 * If dropping 1 → 0, trigger the tick.
 */
export function decrementPendingOperations() {
  if (pendingOperations <= 0) {
    console.warn("decrementPendingOperations() called at zero");
    return 0;
  }
  pendingOperations--;
  console.log("✅ Pending operations:", pendingOperations);
  if (pendingOperations === 0) {
    notifySpinnerOrTick();
  }
  return pendingOperations;
}

/**
 * Wrap any async function so that pendingOperations is
 * incremented before it runs, and always decremented
 * after it finishes (even if it throws).
 *
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withPending(fn) {
  try {
    incrementPendingOperations();
    return await fn();
  } finally {
    decrementPendingOperations();
  }
}
