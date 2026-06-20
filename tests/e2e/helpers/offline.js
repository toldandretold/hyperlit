/**
 * Offline-mode primitives for e2e: flip the network, force a flush, and wait for
 * the offline sync queue to drain to Postgres.
 *
 * How offline works in the app (no service-worker magic for writes):
 *   - The SW (`public/sw.js:97`) SKIPS `/api/*` — it never queues or replays writes.
 *     It only does NetworkFirst HTML + CacheFirst assets. So all the offline→online
 *     write behaviour is the client sync queue, gated on `navigator.onLine`.
 *   - While offline, the debounced master sync (`syncQueue/master.ts`) builds the
 *     batch, writes a `historyLog` WAL entry as `status:"pending"` when the batch has
 *     node changes, and early-returns before any fetch (line 351).
 *   - Going online fires `window`'s `online` event → `setupOnlineSyncListener` →
 *     `retryFailedBatches` (`pageLoad/onlineRetry.ts:141`), which replays every
 *     pending/failed WAL batch and flips it to `"synced"`.
 *
 * `page.context().setOffline()` toggles `navigator.onLine` AND blocks the network,
 * which is exactly what the queue keys off — no SW required.
 */
import { expect } from '@playwright/test';
import { dumpHistoryLog } from './idbInspect.js';

/**
 * Init script: unregister `public/sw.js` and neuter re-registration.
 *
 * Install via `page.addInitScript(unregisterSwScript)` BEFORE the first nav. The SW
 * never touches `/api/*`, so this isn't about sync correctness — it removes the SW's
 * NetworkFirst HTML offline-shell and its `console.log`/`console.error` chatter, both
 * of which would otherwise add noise to an offline run (and the shell could serve a
 * cached reader page on an offline reload).
 */
export const unregisterSwScript = () => {
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.getRegistrations?.().then(
      (regs) => regs.forEach((r) => r.unregister().catch(() => {})),
      () => {},
    );
  } catch { /* ignore */ }
  try {
    // Block layout.blade.php's `window.load` re-register so the SW can't come back.
    navigator.serviceWorker.register = () => Promise.resolve({ scope: '/', unregister: () => Promise.resolve(true) });
  } catch { /* register is sometimes non-writable; getRegistrations cleanup above still applies */ }
};

/** Go offline and assert the page sees it. */
export async function goOffline(page) {
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine), { timeout: 5000 }).toBe(false);
}

/** Go back online and assert the page sees it. */
export async function goOnline(page) {
  await page.context().setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine), { timeout: 5000 }).toBe(true);
}

/**
 * Belt-and-suspenders after `goOnline`: dispatch a synthetic `online` event so
 * `retryFailedBatches` runs even if the real event raced the listener attach (the
 * listener is wired at reader init + at the end of a renumber). It's idempotent —
 * guarded by `isRetrying` and a `!navigator.onLine` early-return.
 */
export async function forceOnlineFlush(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

/**
 * Wait for the offline queue to drain: every `historyLog` batch for the book has
 * left `pending`/`failed` (i.e. reached `synced`). This is the primary
 * "sync finished" signal — more robust than watching console logs.
 *
 * Surfaces the stuck batches in the failure message (a sub-book RLS 500 manifests
 * here as a batch wedged in `pending`/`failed` forever — see the spec's RLS guard).
 */
export async function waitForSyncDrain(page, bookId, { timeout = 60_000 } = {}) {
  await expect
    .poll(
      async () => {
        const logs = await dumpHistoryLog(page, bookId);
        const stuck = logs.filter((l) => l.status !== 'synced');
        // Stash for the assertion message on the final tick.
        waitForSyncDrain._lastStuck = stuck;
        return stuck.length;
      },
      {
        timeout,
        intervals: [500, 1000, 2000, 3000],
        message: () =>
          `historyLog batches did not all reach "synced" — stuck: ` +
          JSON.stringify(waitForSyncDrain._lastStuck || [], null, 2),
      },
    )
    .toBe(0);
}
