/**
 * readingAnchor — THE accessor for the saved reading position (near-leaf).
 *
 * The reading-position system (lazyLoader/index.ts `forceSavePosition`) saves
 * the topmost visible node's id to sessionStorage/localStorage under
 * `scrollPosition_<bookId>` from a 250ms-throttled scroll handler (and to the
 * server on a 5s debounce). Consumers used to hand-parse that storage in four
 * places with divergent fallback rules and — worse — assume it was CURRENT.
 * It is not: it lags the real position by up to one throttle tick. That
 * assumption is exactly what made the audio player start books from the top.
 *
 * Rules for consumers:
 * - Reading where the user WAS (restore-flavoured logic): `getSavedAnchor()`.
 * - Acting on where the user IS RIGHT NOW (start audio here, open search
 *   here, place the caret here, bookmark here): `getFreshAnchor()` — it runs
 *   the lazyLoader's proven detector synchronously first, so the anchor is
 *   exact, not up-to-250ms old.
 * - Never read `scrollPosition_*` storage directly — a guardrail test
 *   (tests/javascript/architecture/scrollPositionAccessor.test.js) fails any
 *   new file that does.
 *
 * Import posture: only the zero-import currentLazyLoaderState leaf — safe to
 * import from anywhere without cycle risk (the [[circular-import-tdz-leaf-state]]
 * idiom). The storage key format is inlined (not imported from the indexedDB
 * barrel) for the same reason; the guardrail test pins every construction site.
 */

import { currentLazyLoader } from '../pageLoad/currentLazyLoaderState';

export interface ReadingAnchor {
  /** The node's DOM id (= NodeRecord.startLine serialization, e.g. "150.5"). */
  elementId: string;
}

/** Same shape the writer enforces (lazyLoader forceSavePosition). */
const NUMERIC_ID = /^\d+(\.\d+)?$/;

/**
 * Last SAVED anchor for a book — sessionStorage first (this tab's live
 * position), then localStorage (survives fresh tabs). May lag the real
 * position by up to 250ms (the scroll-save throttle); if "now" matters,
 * use getFreshAnchor() instead. Returns null when nothing valid is stored.
 */
export function getSavedAnchor(bookId: string): ReadingAnchor | null {
  // Key format mirrors indexedDB getLocalStorageKey('scrollPosition', bookId).
  const key = `scrollPosition_${bookId}`;
  // An INVALID session value (legacy raw "0", corrupt JSON) still falls
  // through to localStorage — not just a missing one.
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const elementId = parsed?.elementId;
      if (typeof elementId === 'string' && NUMERIC_ID.test(elementId)) {
        return { elementId };
      }
    } catch { /* try the next store */ }
  }

  return null;
}

/**
 * The CURRENT anchor: synchronously re-run the reading-position detector
 * (no throttle wait), then read the saved value. This is the call for any
 * feature that acts on "where the reader is right now".
 *
 * Uses the guarded save (not the lock-bypassing force variant) so a
 * programmatic navigation in flight — when the DOM position is mid-animation
 * and meaningless — falls back to the last honest anchor instead of saving
 * garbage. If the active loader is for a different book than `bookId`, the
 * save writes that loader's own key and this read is unaffected.
 */
export function getFreshAnchor(bookId: string): ReadingAnchor | null {
  currentLazyLoader?.saveScrollPosition?.();

  return getSavedAnchor(bookId);
}
