/**
 * Cascade-origin shared state — isolated leaf module (zero imports) to guarantee no TDZ.
 *
 * Tracks the highlight ID that originated a cascade so it survives chunk re-renders.
 * Lives here (not in scrolling) because scrolling sits in a large circular-import
 * cycle; reading these accessors from a partially-evaluated scrolling threw
 * "Cannot access 'cascadeOriginTargetId' before initialization". A leaf module with no
 * imports always finishes initializing before anyone reads it, so it cannot TDZ.
 */

let cascadeOriginTargetId = null;

/** Get the current cascade-origin highlight ID (for re-applying after chunk loads) */
export function getCascadeOriginId() {
  return cascadeOriginTargetId;
}

/** Set the cascade-origin highlight ID (for persisting across chunk re-renders) */
export function setCascadeOriginId(id) {
  cascadeOriginTargetId = id;
}

/** Clear the cascade-origin state (called when container closes) */
export function clearCascadeOriginId() {
  cascadeOriginTargetId = null;
}
