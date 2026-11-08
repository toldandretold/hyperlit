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
 */

import type { BookId } from '../types';
import { log, verbose } from '../../utilities/logger';

const RECONCILE_DELAY_MS = 2_000;
/** Per-book report cooldown so a persistent divergence doesn't spam the sink. */
const REPORT_COOLDOWN_MS = 5 * 60_000;

const _timers = new Map<BookId, ReturnType<typeof setTimeout>>();
const _lastReportTs = new Map<BookId, number>();
/** Full-book replaces in flight per book (a counter: replaces can overlap). */
const _replacesInFlight = new Map<BookId, number>();

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
}

/** Schedule a reconcile for the book (latest-wins; runs after a short quiet delay). */
export function scheduleServerCountReconcile(bookId: BookId, serverCount: number): void {
  const existing = _timers.get(bookId);
  if (existing) clearTimeout(existing);
  _timers.set(
    bookId,
    setTimeout(() => {
      _timers.delete(bookId);
      void reconcileServerNodeCount(bookId, serverCount);
    }, RECONCILE_DELAY_MS),
  );
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

    log.error(
      `Server/IDB node-count divergence for ${bookId}: local ${localCount}, server ${serverCount} ` +
        `— the server acknowledged syncs it did not fully persist (or holds rows this client lost)`,
      '/indexedDB/serverSync/countReconcile.ts',
    );

    const now = Date.now();
    if (now - (_lastReportTs.get(bookId) ?? 0) >= REPORT_COOLDOWN_MS) {
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
