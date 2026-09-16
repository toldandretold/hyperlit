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

/** SPA nav re-inits components; guard so one entry sends exactly one beacon. */
let sentForThisEntry = false;

async function post(page: string): Promise<void> {
  try {
    await fetch('/api/database-to-indexeddb/page-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ page }),
      // Telemetry must never hold up or break the page it measures.
      keepalive: true,
    });
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
