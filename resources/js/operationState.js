// operationState.js

import { showSpinner } from "./editIndicator.js";

let pendingOperations = 0;
let unloadWarningActive = false;
let programmaticUpdateInProgress = false;
export let pasteInProgress = false;

export let hypercitePasteInProgress = false;
export let keyboardLayoutInProgress = false;


let initialBookSyncPromise = null;

/**
 * Stores the promise for the initial book creation sync.
 * @param {Promise<void> | null} promise
 */
export function setInitialBookSyncPromise(promise) {
  console.log("SYNC STATE: Initial book sync promise has been set.");
  initialBookSyncPromise = promise;
}

/**
 * Retrieves the promise for the initial book creation sync.
 * @returns {Promise<void> | null}
 */
export function getInitialBookSyncPromise() {
  return initialBookSyncPromise;
}




export function setKeyboardLayoutInProgress(value) {
  keyboardLayoutInProgress = value;
  console.log(`🔧 KeyboardManager: Layout in progress = ${value}`);
}

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
 * Returns whether we're in a hypercite paste.
 */
export function getHandleHypercitePaste() {
  return hypercitePasteInProgress;
}

/**
 * Set (or clear) the hypercite-paste in-progress flag.
 */
export function setHandleHypercitePaste(value) {
  hypercitePasteInProgress = value;
  return hypercitePasteInProgress; 
}

/**
 * Internal helper: whenever pendingOperations changes,
 * show spinner if >0. Tick is now only shown on successful server sync.
 */
function notifySpinnerOrTick() {
  if (pendingOperations > 0) {
    showSpinner();
  }
  // Note: showTick() removed - now only shows green after successful server sync
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

export let currentObservedChunk = null;
export let chunkOverflowInProgress = false;


// Function to update the currentObservedChunk
export function setCurrentObservedChunk(chunk) {
  currentObservedChunk = chunk;
  return chunk;
}
// Function to update the flag
export function setChunkOverflowInProgress(value) {
  chunkOverflowInProgress = value;
  return value;
}


export function setProgrammaticUpdateInProgress(isUpdating) {
  programmaticUpdateInProgress = isUpdating;
}

export function isProgrammaticUpdateInProgress() {
  return programmaticUpdateInProgress;
}


export function isPasteInProgress() {
  return pasteInProgress;
}

export function setPasteInProgress(value) {
  console.log(`🚩 Paste In Progress state set to: ${value}`);
  pasteInProgress = value;
}
