/**
 * Page-view telemetry for the non-reader surfaces (home, and shelf feeds —
 * see recordShelfFeedView).
 *
 * The reading telemetry in this folder deliberately refuses to count anything
 * outside a reader page — home/user/journal render synthetic feed books
 * through the same lazyLoader, and those are not book reads. That left
 * homepage traffic entirely unmeasured; this is the separate mechanism that
 * covers it, writing to `page_views` rather than `book_reads`.
 *
 * One post per page ENTRY. The server dedupes to one row per identity per day,
 * so the number on /maintainer/stats is "distinct visitors today", the same
 * unit as a book view — not raw hits. Re-posting on a revisit is therefore
 * harmless, which is why there's no client-side "already sent" persistence.
 */

import { verbose } from '../utilities/logger';
import { drainResponse } from '../utilities/drainResponse';

/** SPA nav re-inits components; guard so one entry sends exactly one beacon. */
let sentForThisEntry = false;

/**
 * A shelf feed's render id: `shelf_{uuid}_{sort}` (+ `_pub` for the public
 * render). The uuid is the stable key — sort and audience change the id.
 * Same shape as indexedDB/core/utilities.ts SHELF_FEED_RE, with a capture.
 */
const SHELF_FEED_ID_RE = /^shelf_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})_/;

/** Shelves already reported this page entry (sort-tab switches re-mount the feed). */
const sentShelves = new Set<string>();

async function post(page: string): Promise<void> {
  try {
    // drainResponse is not optional here: this endpoint 401s BY DESIGN whenever
    // there is no identity yet (no session and no anon_token cookie — a
    // first-ever visit, or any load where the token mint hasn't landed), so the
    // undrained path is the NORMAL one. Left undrained it held the request open
    // and no home page ever reached network-idle, which hung ~30 e2e specs.
    await drainResponse(await fetch('/api/database-to-indexeddb/page-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ page }),
      // Telemetry must never hold up or break the page it measures.
      keepalive: true,
    }));
  } catch (error) {
    // A rejected fetch here is a NETWORK outcome (offline, a dropped
    // connection, Chrome refusing a keepalive request) — routine for a
    // best-effort beacon, and the server dedupes so the next entry makes up
    // for it. Not an app error: log.error emits console.error, which made an
    // offline home visit look broken and failed the SPA grand tour on one
    // dropped POST. Same contract as flushReadingTelemetry's silent catch.
    verbose.debug('pageViewTelemetry: post failed (best-effort, ignored)', '/scrolling/pageViewTelemetry.ts', error);
  }
}

/**
 * A shelf view = someone opened that shelf's feed — an archive (/a/) or
 * journal (/j/) page, or a shelf tab on a user page. Called by the code that
 * mounts a feed's `.main-content` (homepageDisplayUnit / contentSwapHelpers)
 * with the feed's render id; anything that isn't a shelf feed is ignored.
 * Once per shelf per page entry; the server dedupes per reader per day.
 */
export function recordShelfFeedView(feedBookId: string): void {
  const shelfId = SHELF_FEED_ID_RE.exec(feedBookId)?.[1]?.toLowerCase();
  if (!shelfId) return;
  if (sentShelves.has(shelfId)) return;
  sentShelves.add(shelfId);
  void post(`shelf:${shelfId}`);
}

/* ── ButtonRegistry lifecycle ─────────────────────────────────────────── */

/**
 * Registered for the 'home' page only. Registry-managed (not a @vite
 * side-effect) so an in-SPA navigation back to home counts as a new view —
 * a module-level side effect would fire on full load and never again.
 */
export function initPageViewTelemetry(): void {
  if (document.body.getAttribute('data-page') !== 'home') return;
  if (sentForThisEntry) return;
  sentForThisEntry = true;
  void post('home');
}

export function destroyPageViewTelemetry(): void {
  // Leaving the page arms the next entry.
  sentForThisEntry = false;
  sentShelves.clear();
}
