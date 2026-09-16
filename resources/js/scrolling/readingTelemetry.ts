/**
 * Reading-depth telemetry — which chunks the reader actually had ON SCREEN.
 *
 * Piggybacks the 250ms-throttled scroll detector in lazyLoader's
 * forceSavePosition (no observers of its own): each tick we union the
 * currently-visible chunk ids into a per-book cumulative set, then flush the
 * FULL set on a slow debounce / tab-hide / nav-away. The server merge is
 * idempotent (jsonb union keyed one row per reader per day), so resending the
 * whole set every time is deliberate — it makes the fetch-vs-beacon race and
 * lost flushes harmless.
 *
 * "Visible" ≠ "loaded": DOM chunks run 150px ahead of the viewport and
 * background download fills IndexedDB with the whole book — this module only
 * ever counts what isWithinViewport says is in the scrollport band.
 */

import { isWithinViewport } from '../lazyLoader/utilities/windowChunks';
import { parseChunkId } from '../indexedDB/types';

const FLUSH_DEBOUNCE_MS = 15000;

interface TelemetryState {
  bookId: string;
  chunks: Set<number>;
  totalChunks: number | null;
  dirty: boolean;
}

let state: TelemetryState | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;

/**
 * Called from forceSavePosition on every (throttled) scroll tick.
 * Reader pages only — home/user/journal feeds render synthetic books through
 * the same lazyLoader, and those must not count as book views.
 */
export function recordVisibleChunks(
  bookId: string,
  container: HTMLElement,
  scrollableParent: Window | HTMLElement,
): void {
  if (!bookId) return;
  // Sub-books (id contains '/', e.g. "book_X/HL_Y") are preview popovers, not
  // reads — same rule as readingPosition. The parent book's own ticks keep
  // recording while a popover is open.
  if (bookId.includes('/')) return;
  if (document.body.getAttribute('data-page') !== 'reader') return;

  if (state && state.bookId !== bookId) {
    // Book switch mid-session: flush what the old book accumulated, then reset.
    flushReadingTelemetry();
    state = null;
  }

  if (!state) {
    state = {
      bookId,
      chunks: new Set(),
      // chunkManifest is nulled once the background download completes — grab
      // the total on the earliest tick we can. The server GREATEST-merges, so
      // a null sent later never regresses an earlier real value.
      totalChunks: (window as any).chunkManifest?.length ?? null,
      dirty: false,
    };
  } else if (state.totalChunks === null) {
    state.totalChunks = (window as any).chunkManifest?.length ?? null;
  }

  const chunkEls = container.querySelectorAll<HTMLElement>('.chunk[data-chunk-id]');
  if (chunkEls.length === 0) return;

  let added = false;
  for (const el of chunkEls) {
    if (!isWithinViewport(el, scrollableParent)) continue;
    const attr = el.getAttribute('data-chunk-id');
    if (attr === null) continue;
    const id = parseChunkId(attr); // parseFloat — fractional chunk ids exist
    if (Number.isNaN(id)) continue;
    if (!state.chunks.has(id)) {
      state.chunks.add(id);
      added = true;
    }
  }

  if (added) {
    state.dirty = true;
    armFlushTimer();
  }

  if (!listenersInstalled) {
    listenersInstalled = true;
    // Flush when the tab hides or the page unloads — the beacon path.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushReadingTelemetry();
    });
    window.addEventListener('pagehide', () => flushReadingTelemetry());
  }
}

/**
 * Send the full cumulative set now (if anything new accumulated since the last
 * flush). Safe to call at any time — no-ops when clean. Also called by the
 * lazyLoader's disconnect so SPA nav away from the reader flushes.
 */
export function flushReadingTelemetry(): void {
  if (!state || !state.dirty || state.chunks.size === 0) return;
  state.dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const url = `/api/database-to-indexeddb/books/${encodeURIComponent(state.bookId)}/read-telemetry`;
  const payload = JSON.stringify({
    chunks: Array.from(state.chunks),
    total_chunks: state.totalChunks,
  });

  // sendBeacon first (survives unload; the route is CSRF-exempt), keepalive
  // fetch as the fallback. Both fire-and-forget — telemetry is best-effort.
  try {
    const blob = new Blob([payload], { type: 'application/json' });
    if (navigator.sendBeacon && navigator.sendBeacon(url, blob)) return;
  } catch {
    // fall through to fetch
  }
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    keepalive: true,
    body: payload,
  }).catch(() => {});
}

function armFlushTimer(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushReadingTelemetry();
  }, FLUSH_DEBOUNCE_MS);
}
