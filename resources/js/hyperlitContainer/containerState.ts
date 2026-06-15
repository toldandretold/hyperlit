/**
 * Shared mutable state for the hyperlit container orchestrator — a zero-sibling-import
 * leaf (the subBookState.ts pattern) so editMode / containerListeners / postOpen / the
 * per-type handlers can read+write it WITHOUT importing ./index, which would re-create
 * the index↔* import cycles this decomposition removes.
 *
 * Flags live on a single mutable object so consumers use plain property access for both
 * read (`if (containerState.mainEditorWasActive)`) and write
 * (`containerState.mainEditorWasActive = true`) — no getter/setter boilerplate.
 */

export const containerState = {
  // Debounce: blocks duplicate click handlers.
  isProcessingClick: false,
  // Whether the main editor was observing before a sub-book editor took over (restored on close).
  mainEditorWasActive: false,
  // Snapshot of (window as any).isEditing taken before the container opened.
  previousIsEditing: false,
  // Re-entrancy guard for the edit-button save ceremony (prevents race with concurrent close).
  isSavingEditToggle: false,
  // Prevents duplicate focusin listeners from attachSubBookFocusSwitcher.
  focusSwitcherAttached: false,
};

/** Getter kept for external callers (initializePage). */
export function isClickProcessing() { return containerState.isProcessingClick; }

// All listeners added during container open, tracked so they can be removed on close.
export const activeListeners: any[] = [];

/** Register an event listener and track it for cleanup. */
export function registerListener(element: any, event: any, handler: any, options: any = {}) {
  element.addEventListener(event, handler, options);
  activeListeners.push({ element, event, handler, options });
}

/**
 * Snapshot module-level state so it can be restored when a stacked layer is popped.
 * (Lives here, not in ./index, so history.ts / stack.ts import the leaf — breaking the cycle.)
 */
export function saveModuleState() {
  return {
    listeners: [...activeListeners],
    focusSwitcherAttached: containerState.focusSwitcherAttached,
    mainEditorWasActive: containerState.mainEditorWasActive,
    previousIsEditing: containerState.previousIsEditing,
  };
}

/** Restore module-level state from a snapshot. */
export function restoreModuleState(state: any) {
  if (!state) return;
  activeListeners.length = 0;
  activeListeners.push(...state.listeners);
  containerState.focusSwitcherAttached = state.focusSwitcherAttached;
  containerState.mainEditorWasActive = state.mainEditorWasActive;
  containerState.previousIsEditing = state.previousIsEditing;
}

/** Reset module-level state for a fresh layer. */
export function resetModuleState() {
  activeListeners.length = 0;
  containerState.focusSwitcherAttached = false;
  containerState.mainEditorWasActive = false;
  containerState.previousIsEditing = false;
}
