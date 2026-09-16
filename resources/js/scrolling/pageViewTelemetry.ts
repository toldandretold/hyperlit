/**
 * Page-view telemetry for the non-reader surfaces (home).
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

import { log } from '../utilities/logger';
import { drainResponse } from '../utilities/drainResponse';

/** SPA nav re-inits components; guard so one entry sends exactly one beacon. */
let sentForThisEntry = false;

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
    log.error('pageViewTelemetry: post failed', '/scrolling/pageViewTelemetry.ts', error);
  }
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
  // Leaving home arms the next entry.
  sentForThisEntry = false;
}
