/**
 * serverSync/flush — drain the whole edit pipeline to the server before a
 * destructive clear+redownload (or logout), so no unsaved work is lost.
 *
 * Pipeline: footnote debounces → input debounce → SaveQueue → masterSync.
 * Split out of the former resources/js/postgreSQL.js.
 *
 * IT REPORTS, IT DOESN'T ASSUME. The old version fired the four flushes, raced
 * the last one against a 5s timer and resolved — so callers read "flushed" as
 * "it's on the server". Two ways that lied:
 *   1. `debounce().flush()` only runs the pending TIMER. Once the 3s timer has
 *      fired, masterSync is mid-drain and flush() returns an already-resolved
 *      promise — the round trip is never awaited. And because the drain does
 *      `pendingSyncs.clear()` at its TOP, the old `pendingSyncs.size === 0`
 *      fast path also read "nothing to do" while a POST was in flight.
 *   2. Even when it did await, the 5s cap resolved silently on a slow link.
 * Whoever called next then destroyed the local copy. On logout that is
 * permanent (clearDatabase() takes historyLog, so the replay path dies with
 * it); the e2ee lifecycle test's vanished edit was this exact sequence.
 *
 * So: wait for the in-flight drain (getMasterSyncInFlight), re-check the real
 * "is anything unsent" signal — the queue plus historyLog rows in the two
 * statuses retryFailedBatches replays — and hand the caller a verdict. A
 * caller that is about to destroy local data MUST act on `synced === false`
 * (warn, or don't destroy); it must never be silently discarded again.
 */
import { verbose } from '../../utilities/logger';

export interface FlushResult {
  /** True only when nothing is left unsent: empty queue, no in-flight drain, no replayable rows. */
  synced: boolean;
  /** How many replayable historyLog batches are still unsent (0 when synced). */
  pendingBatches: number;
  /** True when the budget ran out with work still pending (as opposed to a clean "nothing to do"). */
  timedOut: boolean;
}

/** Default budget for the whole flush. Callers that are about to WIPE should pass more. */
const DEFAULT_BUDGET_MS = 15_000;

/**
 * Replayable batches still sitting in historyLog: 'pending' (queued/offline) and
 * 'failed' (server rejected, will retry) — exactly what retryFailedBatches picks
 * up. 'stale' is EXCLUDED on purpose: a 409'd batch is parked forever by design
 * (re-POSTing it 409s again), so counting it would make every later logout warn.
 */
async function countUnsentBatches(): Promise<number> {
  try {
    const { openDatabase } = await import('../core/connection'); // the leaf, not the barrel
    const db = await openDatabase();
    const counts = await Promise.all(['pending', 'failed'].map((status) => new Promise<number>((resolve) => {
      try {
        const index = db.transaction('historyLog', 'readonly').objectStore('historyLog').index('status');
        const request = index.count(status);
        request.onsuccess = () => resolve(request.result || 0);
        request.onerror = () => resolve(0);
      } catch { resolve(0); }
    })));
    return counts.reduce((a, b) => a + b, 0);
  } catch {
    return 0; // can't read the log — don't invent pending work
  }
}

/** Queued-but-not-yet-cut edits (masterSync empties this at the TOP of a drain). */
async function queuedCount(): Promise<number> {
  try {
    const { pendingSyncs } = await import('../syncQueue/queue');
    return pendingSyncs.size;
  } catch {
    return 0;
  }
}

/**
 * Flush the entire editing pipeline so no unsaved work is lost, and REPORT
 * whether it actually reached the server.
 *
 * @param options.budgetMs  Overall wall-clock budget (default 15s). The flush
 *   returns early the moment nothing is left unsent; the budget only bounds a
 *   genuinely slow/failing server.
 */
export async function flushAllPendingEdits(
  options: { budgetMs?: number } = {},
): Promise<FlushResult> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  const { getMasterSyncInFlight } = await import('../syncQueue/master')
    .catch(() => ({ getMasterSyncInFlight: () => null }));

  // Fast path: nothing typed, nothing queued, nothing in flight, nothing parked.
  // (All four — the old version checked only the queue, which a running drain
  // has already emptied.)
  const idle = !(window as { isEditing?: boolean }).isEditing
    && (await queuedCount()) === 0
    && !getMasterSyncInFlight()
    && (await countUnsentBatches()) === 0;
  if (idle) {
    return { synced: true, pendingBatches: 0, timedOut: false };
  }

  verbose.content('Flushing all pending edits before clear+redownload', 'serverSync/flush');

  // 1. Flush footnote annotation debounces
  try {
    const { flushPendingFootnoteSaves } = await import('../../footnotes/footnoteAnnotations');
    flushPendingFootnoteSaves();
  } catch (e) {
    verbose.content(`Footnote flush skipped: ${(e as Error).message}`, 'serverSync/flush');
  }

  // 2. Flush input debounce (200ms timer)
  try {
    const { flushInputDebounce } = await import('../../divEditor/index');
    flushInputDebounce();
  } catch (e) {
    verbose.content(`Input debounce flush skipped: ${(e as Error).message}`, 'serverSync/flush');
  }

  // 3. Flush SaveQueue → IndexedDB (1.5s timer)
  try {
    const { flushAllPendingSaves } = await import('../../divEditor/index');
    await flushAllPendingSaves();
  } catch (e) {
    verbose.content(`SaveQueue flush skipped: ${(e as Error).message}`, 'serverSync/flush');
  }

  // 4. Drive masterSync → server until nothing is unsent (or the budget ends).
  //    Each pass: fire the pending timer, await the RUNNING drain, then re-read
  //    the unsent signal. A drain can cut a fresh batch while we wait (a save
  //    landing mid-flush), hence the loop rather than a single await.
  let pendingBatches = await countUnsentBatches();
  let retriedParked = false;
  while (Date.now() < deadline) {
    try {
      const { debouncedMasterSync } = await import('../syncQueue/master');
      await debouncedMasterSync.flush();          // runs the timer if one is pending
      await getMasterSyncInFlight();              // awaits the round trip if one is running
    } catch (e) {
      verbose.content(`masterSync flush failed: ${(e as Error).message}`, 'serverSync/flush');
    }

    pendingBatches = await countUnsentBatches();
    const stillQueued = await queuedCount();
    if (pendingBatches === 0 && stillQueued === 0 && !getMasterSyncInFlight()) {
      verbose.content('Pending edits flushed', 'serverSync/flush');
      return { synced: true, pendingBatches: 0, timedOut: false };
    }

    // Rows parked by an earlier failure are masterSync's blind spot — it only
    // pushes the CURRENT queue. Replaying them is the app's own recovery path,
    // so give it exactly one go before declaring the work unsent.
    if (!retriedParked && pendingBatches > 0 && stillQueued === 0) {
      retriedParked = true;
      try {
        const { retryFailedBatches } = await import('../../pageLoad/onlineRetry');
        await retryFailedBatches();
      } catch (e) {
        verbose.content(`Parked-batch retry skipped: ${(e as Error).message}`, 'serverSync/flush');
      }
      pendingBatches = await countUnsentBatches();
      if (pendingBatches === 0 && (await queuedCount()) === 0 && !getMasterSyncInFlight()) {
        return { synced: true, pendingBatches: 0, timedOut: false };
      }
    }

    // Nothing queued, nothing in flight, and the replay has had its turn: more
    // waiting cannot change the answer. Report now instead of burning the whole
    // budget — this path runs on every clear+redownload, not just on logout.
    if (retriedParked && stillQueued === 0 && !getMasterSyncInFlight()) {
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }

  const timedOut = Date.now() >= deadline;
  verbose.content(
    timedOut
      ? `Flush budget (${budgetMs}ms) exhausted with ${pendingBatches} batch(es) unsent`
      : `Flush gave up with ${pendingBatches} batch(es) the server would not take`,
    'serverSync/flush',
  );
  return { synced: false, pendingBatches, timedOut };
}
