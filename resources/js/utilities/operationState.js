// operationState.js

import { glowCloudOrange } from "../components/editIndicator.js";

let pendingOperations = 0;
let unloadWarningActive = false;
let programmaticUpdateInProgress = false;
export let pasteInProgress = false;

export let hypercitePasteInProgress = false;
export let keyboardLayoutInProgress = false;
let keyboardWasRecentlyClosed = false;
let undoRedoInProgress = false;


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

export function isUndoRedoInProgress() {
  return undoRedoInProgress;
}

export function setUndoRedoInProgress(value) {
  undoRedoInProgress = value;
}

export function getKeyboardWasRecentlyClosed() {
  return keyboardWasRecentlyClosed;
}

export function setKeyboardWasRecentlyClosed(value) {
  keyboardWasRecentlyClosed = value;
  console.log(`⌨️ KeyboardManager: Keyboard was recently closed = ${value}`);
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
 * glow cloud orange if >0. Green glow is now only shown on successful server sync.
 */
function notifySpinnerOrTick() {
  if (pendingOperations > 0) {
    glowCloudOrange();
  }
  // Note: glowCloudGreen() removed - now only shows green after successful server sync
}

/**
 * Increment the pending-operations counter.
 * If going 0 → 1, glow cloud orange.
 */
export function incrementPendingOperations() {
  pendingOperations++;
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
  //console.log("✅ Pending operations:", pendingOperations);
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
export let renumberingInProgress = false;
export let userDeletionInProgress = false;


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
// Function to update renumbering flag
export function setRenumberingInProgress(value) {
  renumberingInProgress = value;
  return value;
}
// Function to update user deletion flag
export function setUserDeletionInProgress(value) {
  userDeletionInProgress = value;
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

// Track newly created highlights for proper CSS application during lazy loader refresh
let newlyCreatedHighlights = new Set();

export function addNewlyCreatedHighlight(highlightId) {
  newlyCreatedHighlights.add(highlightId);
  console.log(`🎨 Added ${highlightId} to newly created highlights. Total: ${newlyCreatedHighlights.size}`);
}

export function isNewlyCreatedHighlight(highlightId) {
  return newlyCreatedHighlights.has(highlightId);
}

export function removeNewlyCreatedHighlight(highlightId) {
  const removed = newlyCreatedHighlights.delete(highlightId);
  if (removed) {
    console.log(`🎨 Removed ${highlightId} from newly created highlights. Remaining: ${newlyCreatedHighlights.size}`);
  }
  return removed;
}

export function clearNewlyCreatedHighlights() {
  const count = newlyCreatedHighlights.size;
  newlyCreatedHighlights.clear();
  console.log(`🎨 Cleared all ${count} newly created highlights`);
}

// Track whether we should skip scroll restoration (e.g., during hash navigation)
let skipScrollRestoration = false;

export function setSkipScrollRestoration(value) {
  skipScrollRestoration = value;
  console.log(`🔒 Skip scroll restoration set to: ${value}`);
  return skipScrollRestoration;
}

export function shouldSkipScrollRestoration() {
  return skipScrollRestoration;
}

// Track perimeter button visibility state (single source of truth)
let arePerimeterButtonsHidden = false;

export function setPerimeterButtonsHidden(value) {
  arePerimeterButtonsHidden = value;
  return arePerimeterButtonsHidden;
}

export function getPerimeterButtonsHidden() {
  return arePerimeterButtonsHidden;
}
