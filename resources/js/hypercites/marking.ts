/**
 * Hypercite marking — live re-stamp of a source hypercite's relationship status
 * in the CURRENT tab's DOM.
 *
 * WHY THIS EXISTS
 * When you paste a citation, the SOURCE hypercite goes single→couple (or →poly).
 * Its stored data (normalized `hypercites` table + the node's embedded array +
 * Postgres) is updated and synced, so a fresh page load renders the new status
 * correctly. But the SAME tab that made the citation does NOT get a live refresh
 * of the source marking:
 *   - the BroadcastChannel self-skips its own broadcast (avoids clobbering the
 *     node being edited), and
 *   - `updateDomNode` only re-renders the CURRENT book — for a cross-book citation
 *     the source book is not the current book, so it is never touched.
 * The paste handler used to fall back to a bare `element.className = newStatus`,
 * which (a) missed the `--hypercite-intensity` inline var that a real render sets,
 * and (b) never (re)attached the click listener that only lives on couple/poly
 * markers. This helper does the complete, render-equivalent re-stamp.
 *
 * Safe to call when the source `<u>` is not in the DOM (a no-op) — the navigate-
 * away case is covered by the fresh IDB re-render on SPA navigation.
 */

import type { RelationshipStatus } from '../indexedDB/types';
import { attachUnderlineClickListeners } from './listeners';

// Mirror the lone-cite seed of the overlap ramp in lazyLoader/chunkRender.ts
// (applyHypercites → RAMP_BASE). A single couple/poly cite renders at this
// intensity; keeping parity here means the live re-stamp looks identical to a
// fresh render instead of falling through to the CSS resting fallback.
const RAMP_BASE = 0.30;

/**
 * Re-stamp every rendered instance of a hypercite `<u>` marker in the current
 * DOM to `status`, matching what a fresh render (applyHypercites) produces:
 *   - class = status (single | couple | poly)
 *   - `--hypercite-intensity` inline var set for couple/poly, cleared for single
 *   - couple/poly click listener (re)attached
 *
 * Hypercite ids are globally unique, so this targets exactly the source marker
 * wherever it lives (main content, a source/AI-review panel, a sub-book
 * container). Returns the number of DOM elements updated.
 */
export function restampHyperciteStatusInDOM(
  hyperciteId: string,
  status: RelationshipStatus,
): number {
  if (!hyperciteId || !status) return 0;

  // id-based lookup, but only accept genuine hypercite <u> markers — never the
  // citing <a class="open-icon"> arrow (which shares neither id nor tag) or an
  // unrelated element that happens to collide on id.
  const markers = Array.from(
    document.querySelectorAll<HTMLElement>(`u[id="${CSS.escape(hyperciteId)}"]`),
  );
  if (markers.length === 0) return 0;

  for (const marker of markers) {
    marker.className = status;
    if (status === 'couple' || status === 'poly') {
      marker.style.setProperty('--hypercite-intensity', String(RAMP_BASE));
    } else {
      marker.style.removeProperty('--hypercite-intensity');
    }
  }

  // couple/poly markers carry the click-to-navigate handler; single ones don't.
  // A freshly-promoted couple therefore needs the listener attached now.
  attachUnderlineClickListeners();

  return markers.length;
}
