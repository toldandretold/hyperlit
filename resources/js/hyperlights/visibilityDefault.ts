/**
 * Sticky default visibility for NEW highlights (per-device, localStorage).
 *
 * Product rule: highlights are born public, but once the user flips one via the
 * per-highlight visibility control, that choice becomes the default for future
 * highlights (last-chosen-wins — flipping back to public restores public births).
 *
 * Zero-import leaf on purpose: read at highlight-creation time
 * (hyperlights/database.ts stamps `sub_book_visibility` on the new record; the
 * server honors it only at hyperlight-row creation) and written by
 * hyperlitContainer/hyperlightVisibilityControl.ts on every successful flip.
 */

const STORAGE_KEY = 'hyperlit_default_hl_visibility';

export type HighlightVisibility = 'public' | 'private';

export function getDefaultHighlightVisibility(): HighlightVisibility {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'private' ? 'private' : 'public';
  } catch {
    return 'public';
  }
}

export function setDefaultHighlightVisibility(visibility: HighlightVisibility): void {
  try {
    localStorage.setItem(STORAGE_KEY, visibility);
  } catch {
    // Storage denial (private mode) — the default just doesn't stick; non-fatal.
  }
}
