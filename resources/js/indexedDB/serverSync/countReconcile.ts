/**
 * countReconcile — the layer-3 end-state check: does POSTGRES hold what IDB holds?
 *
 * The integrity sweeps compare DOM ↔ IndexedDB; the sync layer's only proof the
 * server took a write is the response envelope. Neither notices a server that says
 * `success: true` while persisting the wrong thing — which shipped (prod 2026-11-01):
 * positional batchDelete ate 41 freshly pasted /terms + /privacy nodes, every client
 * batch read `synced`, and the books served fragments for three weeks while the
 * author's own browser showed them complete. See CLAUDE.md §"A node's id is its
 * position" (server mirror rule).
 *
 * So every node-bearing unified-sync response now carries `server_node_count` (the
 * book's post-write row count), and masterSync schedules this reconciler with it.
 * Once the pipeline is QUIET for the book, local count ≠ server count means the two
 * stores have silently diverged → log.error + an integrity report (no modal — the
 * local copy is intact; this is a flare, not a data-loss prompt).
 *
 * Quiet means ALL of:
 *   - no queued-but-uncut edits for the book (pendingSyncs),
 *   - no replayable historyLog batches for the book ('pending'/'failed' — 'stale'
 *     is parked forever by design, counting it would alarm on every 409'd book),
 *   - no drain in flight (getMasterSyncInFlight),
 *   - no background chunk download in progress for the book (a partial local copy
 *     legitimately undercounts).
 * Any gate failing just skips — the NEXT sync reschedules with a fresher count, so
 * a busy session converges to a checked one. Latest-wins per book: a newer schedule
 * replaces a pending one, so the comparison always uses the newest server count.
 *
 * Full-book replaces (the paste/undo/vacuum `POST /api/db/nodes/upsert` — the
 * NUCLEAR path, which bypasses unified-sync) are bracketed by
 * `beginFullBookReplace` / `endFullBookReplace`. Without that, a count scheduled
 * by the select-all-delete sync just BEFORE a paste fired 2s later against the
 * pasted IDB and reported "local 36, server 1" while Postgres already held all 36
 * (prod 2026-11-07, /privacy). Begin cancels the stale timer and holds the gate
 * shut; end reschedules with the replace's own post-write count.
 *
 * A SHORT LOCAL COPY IS NOT A DIVERGENCE. The first render stores one chunk and the
 * background download brings the rest; when that download never completed, "local 400,
 * server 3062" is a fact about this browser's cache, not about the server — yet it was
 * reported as "the server acknowledged syncs it did not fully persist" (prod 2026-11-22,
 * while the server log read before 3062 / after 3062 / deleted 0). Two things now keep
 * the alarm honest: a copy `utilities/localCopyCompleteness` knows to be partial is
 * reported as `local-copy-incomplete` (a warning, its own trigger), and
 * `shouldRepairShortLocalCopy` lets the page-load freshness check catch an UNMARKED short
 * copy and re-download it before anyone edits. What still reaches the divergence report
 * is a shortfall that arose with a copy believed whole — which is news.
 */

import type { BookId } from '../types';
import { log, verbose } from '../../utilities/logger';
import {
  isLocalCopyPartial,
  shortRepairAlreadyTried,
  noteShortRepairAttempt,
  clearShortRepairAttempt,
} from '../../utilities/localCopyCompleteness';

const RECONCILE_DELAY_MS = 2_000;
/** Per-book report cooldown so a persistent divergence doesn't spam the sink. */
const REPORT_COOLDOWN_MS = 5 * 60_000;

const _timers = new Map<BookId, ReturnType<typeof setTimeout>>();
const _lastReportTs = new Map<BookId, number>();
/** Full-book replaces in flight per book (a counter: replaces can overlap). */
const _replacesInFlight = new Map<BookId, number>();
/** Reconciles a fired timer started and that haven't finished (see whenServerCountReconcilesSettle). */
const _running = new Set<Promise<unknown>>();

/**
 * Call immediately BEFORE a full-book replace POST. Any pending reconcile for the
 * book is about to compare against a count the replace will invalidate, so drop it,
 * and keep the quiet gate shut until `endFullBookReplace`.
 */
export function beginFullBookReplace(bookId: BookId): void {
  const existing = _timers.get(bookId);
  if (existing) {
    clearTimeout(existing);
    _timers.delete(bookId);
  }
  _replacesInFlight.set(bookId, (_replacesInFlight.get(bookId) ?? 0) + 1);
}

/**
 * Call when the replace settles (success OR failure — always, from a `finally`).
 * Pass the response's `server_node_count` when there is one; a failed replace
 * passes nothing and the next sync's count takes over.
 */
export function endFullBookReplace(bookId: BookId, serverCount?: unknown): void {
  const remaining = (_replacesInFlight.get(bookId) ?? 1) - 1;
  if (remaining > 0) _replacesInFlight.set(bookId, remaining);
  else _replacesInFlight.delete(bookId);
  if (typeof serverCount === 'number') scheduleServerCountReconcile(bookId, serverCount);
}

export interface ReconcileOutcome {
  /** False when a quiet-gate failed and no comparison was made. */
  checked: boolean;
  mismatch: boolean;
  localCount?: number;
  serverCount?: number;
  skippedReason?: string;
  /** True when the shortfall is a known-partial local download, not a divergence. */
  incomplete?: boolean;
}

/** Schedule a reconcile for the book (latest-wins; runs after a short quiet delay). */
export function scheduleServerCountReconcile(bookId: BookId, serverCount: number): void {
  const existing = _timers.get(bookId);
  if (existing) clearTimeout(existing);
  _timers.set(
    bookId,
    setTimeout(() => {
      _timers.delete(bookId);
      const run = reconcileServerNodeCount(bookId, serverCount);
      _running.add(run);
      void run.finally(() => _running.delete(run));
    }, RECONCILE_DELAY_MS),
  );
}

/**
 * Resolves once every reconcile a timer has already started has finished. The reconcile is
 * real async (dynamic imports resolve through the module loader, IDB reads) — waiting a fixed
 * number of ticks for it is a race that loses under load.
 */
export async function whenServerCountReconcilesSettle(): Promise<void> {
  while (_running.size > 0) {
    await Promise.allSettled([..._running]);
  }
}

/** Compare the server's post-write node count against local IDB, when safe to. */
export async function reconcileServerNodeCount(
  bookId: BookId,
  serverCount: number,
): Promise<ReconcileOutcome> {
  try {
    const skippedReason = await quietGateFailure(bookId);
    if (skippedReason) {
      verbose.content(
        `Server-count reconcile skipped for ${bookId}: ${skippedReason}`,
        'serverSync/countReconcile',
      );
      return { checked: false, mismatch: false, skippedReason };
    }

    const localCount = await countLocalNodes(bookId);
    if (localCount === serverCount) {
      return { checked: true, mismatch: false, localCount, serverCount };
    }

    const now = Date.now();
    const reportDue = now - (_lastReportTs.get(bookId) ?? 0) >= REPORT_COOLDOWN_MS;

    // Known-partial local copy: the first-chunk load marked it and no full download ever
    // cleared the mark. The server is not the suspect — say so, and don't cry divergence.
    if (localCount < serverCount && isLocalCopyPartial(bookId)) {
      log.warn(
        `Local copy of ${bookId} is incomplete: ${localCount} of ${serverCount} nodes ` +
          `(the background download never finished) — it is re-downloaded on the next load`,
        '/indexedDB/serverSync/countReconcile.ts',
      );
      if (reportDue) {
        _lastReportTs.set(bookId, now);
        try {
          const { reportLocalCopyIncomplete } = await import('../../integrity/reporter');
          await reportLocalCopyIncomplete({ bookId, localCount, serverCount });
        } catch {
          /* reporter unavailable — the warning above still surfaces it */
        }
      }
      return { checked: true, mismatch: false, incomplete: true, localCount, serverCount };
    }

    // Name the side the numbers point at: the two directions are different bugs.
    const reading = localCount > serverCount
      ? 'the server holds FEWER rows than this client — it acknowledged a write it did not fully persist, or deleted rows it should not have'
      : 'the server holds MORE rows than this client — it refused or skipped a delete, or this client lost rows it once had';
    log.error(
      `Server/IDB node-count divergence for ${bookId}: local ${localCount}, server ${serverCount} — ${reading}`,
      '/indexedDB/serverSync/countReconcile.ts',
    );

    if (reportDue) {
      _lastReportTs.set(bookId, now);
      try {
        const { reportServerCountMismatch } = await import('../../integrity/reporter');
        await reportServerCountMismatch({ bookId, localCount, serverCount });
      } catch {
        /* reporter unavailable — the log.error above still surfaces it */
      }
    }

    return { checked: true, mismatch: true, localCount, serverCount };
  } catch (error) {
    // The reconciler is a watchdog: it must never break the sync path it observes.
    verbose.content(
      `Server-count reconcile errored for ${bookId} (ignored): ${(error as Error).message}`,
      'serverSync/countReconcile',
    );
    return { checked: false, mismatch: false, skippedReason: 'error' };
  }
}

/**
 * Page-load question: this book rendered from the local cache with timestamps level with
 * the server's — but does the cache hold FEWER nodes than the server? If so the copy is a
 * fragment nothing else will ever notice (see the header), and the caller re-downloads.
 *
 * True at most once per observed server count (`shortRepairAlreadyTried`): a repair that
 * completes and still leaves the copy short is a real divergence, and re-downloading on
 * every load would never fix it. Refuses under the same quiet gates as the reconciler —
 * unsent local deletions legitimately make the local copy shorter, and re-downloading
 * over them would resurrect what the user just removed.
 */
export async function shouldRepairShortLocalCopy(bookId: BookId, serverCount: unknown): Promise<boolean> {
  try {
    if (typeof serverCount !== 'number' || !(serverCount > 0)) return false;
    if (await quietGateFailure(bookId)) return false;

    const localCount = await countLocalNodes(bookId);
    if (localCount >= serverCount) {
      clearShortRepairAttempt(bookId);
      return false;
    }
    if (localCount === 0) return false; // nothing cached — the normal load path owns this
    if (shortRepairAlreadyTried(bookId, serverCount)) {
      verbose.content(
        `Local copy of ${bookId} still short (${localCount}/${serverCount}) after a repair — leaving it to the reconciler`,
        'serverSync/countReconcile',
      );
      return false;
    }

    noteShortRepairAttempt(bookId, serverCount);
    log.warn(
      `Local copy of ${bookId} is incomplete: ${localCount} of ${serverCount} nodes — re-downloading the book`,
      '/indexedDB/serverSync/countReconcile.ts',
    );
    return true;
  } catch {
    return false; // a watchdog never breaks the load it observes
  }
}

/** Null when quiet; otherwise the first failing gate's name. */
async function quietGateFailure(bookId: BookId): Promise<string | null> {
  if (_replacesInFlight.get(bookId)) return 'full-book replace in flight';

  const { pendingSyncs } = await import('../syncQueue/queue');
  for (const item of pendingSyncs.values()) {
    const itemBook = (item.data as { book?: string } | undefined)?.book
      ?? (item.originalData as { book?: string } | undefined)?.book;
    if (itemBook === bookId) return 'queued edits pending';
  }

  const { getMasterSyncInFlight } = await import('../syncQueue/master');
  if (getMasterSyncInFlight()) return 'drain in flight';

  if (await hasReplayableBatches(bookId)) return 'unsent historyLog batches';

  const { isBackgroundDownloadInProgress } = await import('../../pageLoad/backgroundDownload');
  if (isBackgroundDownloadInProgress(bookId)) return 'background download in progress';

  return null;
}

/** Replayable ('pending'/'failed') historyLog batches for THIS book. */
async function hasReplayableBatches(bookId: BookId): Promise<boolean> {
  const { openDatabase } = await import('../core/connection');
  const db = await openDatabase();
  const statuses: Array<'pending' | 'failed'> = ['pending', 'failed'];
  const perStatus = await Promise.all(
    statuses.map(
      (status) =>
        new Promise<boolean>((resolve) => {
          try {
            const index = db
              .transaction('historyLog', 'readonly')
              .objectStore('historyLog')
              .index('status');
            const request = index.getAll(status);
            request.onsuccess = () =>
              resolve((request.result || []).some((e: { bookId?: string }) => e.bookId === bookId));
            request.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        }),
    ),
  );
  return perStatus.some(Boolean);
}

/** Cheap IDB count over the nodes store's [book, startLine] primary key. */
async function countLocalNodes(bookId: BookId): Promise<number> {
  const { openDatabase } = await import('../core/connection');
  const db = await openDatabase();
  return new Promise<number>((resolve, reject) => {
    try {
      // Key range covering every [bookId, startLine] pair: [bookId] sorts before
      // any [bookId, x], and [bookId, []] after (arrays order above numbers/strings).
      const range = IDBKeyRange.bound([bookId], [bookId, []]);
      const request = db.transaction('nodes', 'readonly').objectStore('nodes').count(range);
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
    } catch (e) {
      reject(e);
    }
  });
}
