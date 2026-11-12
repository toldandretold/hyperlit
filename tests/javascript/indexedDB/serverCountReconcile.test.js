/**
 * serverSync/countReconcile — the layer-3 end-state watchdog.
 *
 * The bug this pins the DEFENSE for (prod 2026-11-01): the server ACKed every
 * sync batch (`success: true`) while positional deletes silently ate 41 freshly
 * pasted nodes — DOM↔IDB integrity passed (both local sides agreed) and nothing
 * ever compared IDB against Postgres. The reconciler compares the response's
 * post-write `server_node_count` against the local IDB count once the pipeline
 * is quiet, and flares on divergence.
 *
 * Real modules: countReconcile.ts, queue.ts, connection (fake-indexeddb schema).
 * Mocked seams: master's in-flight probe, background download, reporter, logger.
 *
 * NOTE: countReconcile keeps module-level state (report cooldown per book) that
 * survives across tests — every test uses its OWN bookId.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/indexedDB/syncQueue/master', () => ({
  getMasterSyncInFlight: vi.fn(() => null),
}));
vi.mock('../../../resources/js/pageLoad/backgroundDownload', () => ({
  isBackgroundDownloadInProgress: vi.fn(() => false),
}));
vi.mock('../../../resources/js/integrity/reporter', () => ({
  reportServerCountMismatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn(), init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  verbose: { content: vi.fn(), init: vi.fn(), nav: vi.fn(), user: vi.fn() },
}));

import { installFreshIndexedDB, seedStore } from './idbHarness.js';
import {
  reconcileServerNodeCount,
  scheduleServerCountReconcile,
  beginFullBookReplace,
  endFullBookReplace,
  whenServerCountReconcilesSettle,
} from '../../../resources/js/indexedDB/serverSync/countReconcile';
import { getMasterSyncInFlight } from '../../../resources/js/indexedDB/syncQueue/master';
import { isBackgroundDownloadInProgress } from '../../../resources/js/pageLoad/backgroundDownload';
import { reportServerCountMismatch } from '../../../resources/js/integrity/reporter';
import { log } from '../../../resources/js/utilities/logger';
import { pendingSyncs } from '../../../resources/js/indexedDB/syncQueue/queue';

function node(book, startLine) {
  return {
    book, startLine, chunk_id: 0, node_id: `${book}_${startLine}_x`,
    content: `<p id="${startLine}">n${startLine}</p>`, footnotes: [],
  };
}

async function seedBook(book, count) {
  const records = [];
  for (let i = 1; i <= count; i++) records.push(node(book, i * 100));
  await seedStore('nodes', records);
}

beforeEach(() => {
  installFreshIndexedDB();
  pendingSyncs.clear();
  vi.clearAllMocks();
});

describe('reconcileServerNodeCount', () => {
  it('matching counts → checked, no mismatch, no report', async () => {
    await seedBook('book_rc_match', 3);

    const outcome = await reconcileServerNodeCount('book_rc_match', 3);

    expect(outcome).toMatchObject({ checked: true, mismatch: false, localCount: 3, serverCount: 3 });
    expect(reportServerCountMismatch).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('divergence → mismatch flagged, log.error fired, integrity report sent with both counts', async () => {
    // The prod shape: client holds the full paste, server silently kept a fragment.
    await seedBook('book_rc_diverge', 28);

    const outcome = await reconcileServerNodeCount('book_rc_diverge', 5);

    expect(outcome).toMatchObject({ checked: true, mismatch: true, localCount: 28, serverCount: 5 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(reportServerCountMismatch).toHaveBeenCalledWith({
      bookId: 'book_rc_diverge', localCount: 28, serverCount: 5,
    });
  });

  it('a repeat divergence inside the cooldown window logs again but reports only once', async () => {
    await seedBook('book_rc_cooldown', 4);

    await reconcileServerNodeCount('book_rc_cooldown', 2);
    const second = await reconcileServerNodeCount('book_rc_cooldown', 2);

    expect(second.mismatch).toBe(true);
    expect(reportServerCountMismatch).toHaveBeenCalledTimes(1);
  });

  it('counts only the book under reconcile, not its neighbours', async () => {
    await seedBook('book_rc_a', 2);
    await seedBook('book_rc_b', 7);

    const outcome = await reconcileServerNodeCount('book_rc_a', 2);

    expect(outcome).toMatchObject({ checked: true, mismatch: false, localCount: 2 });
  });

  it('skips while the book has queued-but-uncut edits (pendingSyncs)', async () => {
    await seedBook('book_rc_queued', 3);
    pendingSyncs.set('nodes_book_rc_queued_100', {
      store: 'nodes', id: 'book_rc_queued_100', type: 'update',
      data: { book: 'book_rc_queued', startLine: 100 },
    });

    const outcome = await reconcileServerNodeCount('book_rc_queued', 99);

    expect(outcome).toMatchObject({ checked: false, mismatch: false, skippedReason: 'queued edits pending' });
    expect(reportServerCountMismatch).not.toHaveBeenCalled();
  });

  it('does NOT skip for another book\'s queued edits', async () => {
    await seedBook('book_rc_other', 3);
    pendingSyncs.set('nodes_book_rc_elsewhere_100', {
      store: 'nodes', id: 'book_rc_elsewhere_100', type: 'update',
      data: { book: 'book_rc_elsewhere', startLine: 100 },
    });

    const outcome = await reconcileServerNodeCount('book_rc_other', 3);

    expect(outcome.checked).toBe(true);
  });

  it('skips while a drain is in flight', async () => {
    await seedBook('book_rc_drain', 3);
    getMasterSyncInFlight.mockReturnValueOnce(Promise.resolve());

    const outcome = await reconcileServerNodeCount('book_rc_drain', 99);

    expect(outcome).toMatchObject({ checked: false, skippedReason: 'drain in flight' });
    expect(reportServerCountMismatch).not.toHaveBeenCalled();
  });

  it('skips while the book has replayable historyLog batches (pending/failed)', async () => {
    await seedBook('book_rc_replay', 3);
    await seedStore('historyLog', [{
      id: 901, timestamp: Date.now(), bookId: 'book_rc_replay', status: 'failed',
      payload: { book: 'book_rc_replay', updates: { nodes: [] }, deletions: { nodes: [] } },
    }]);

    const outcome = await reconcileServerNodeCount('book_rc_replay', 99);

    expect(outcome).toMatchObject({ checked: false, skippedReason: 'unsent historyLog batches' });
  });

  it('a parked stale batch (409) does NOT block the check', async () => {
    // 'stale' never replays by design — counting it would silence the watchdog
    // forever on exactly the books most likely to have diverged.
    await seedBook('book_rc_stale', 3);
    await seedStore('historyLog', [{
      id: 902, timestamp: Date.now(), bookId: 'book_rc_stale', status: 'stale',
      payload: { book: 'book_rc_stale', updates: { nodes: [] }, deletions: { nodes: [] } },
    }]);

    const outcome = await reconcileServerNodeCount('book_rc_stale', 3);

    expect(outcome.checked).toBe(true);
  });

  it('skips while a background download is in progress for the book (partial local copy)', async () => {
    await seedBook('book_rc_dl', 1);
    isBackgroundDownloadInProgress.mockReturnValueOnce(true);

    const outcome = await reconcileServerNodeCount('book_rc_dl', 40);

    expect(outcome).toMatchObject({ checked: false, skippedReason: 'background download in progress' });
    expect(reportServerCountMismatch).not.toHaveBeenCalled();
  });
});

/*
 * Prod 2026-11-07 (/privacy): select-all-delete synced (server 18 → 1, envelope
 * `server_node_count: 1`) and scheduled a reconcile 2s out. The paste's full-book
 * replace (`/api/db/nodes/upsert`, which bypasses unified-sync) then wrote all 36
 * nodes — and the stale timer fired against the pasted IDB: "local 36, server 1",
 * a false data-loss flare while Postgres held exactly 36.
 */
describe('full-book replace bracketing (paste nuclear upsert)', () => {
  // The reconcile a fired timer starts is real async (dynamic imports resolve through
  // vitest's module runner, IDB runs on setImmediate) — wait for it to FINISH before
  // asserting, or a "no flare" assertion passes vacuously. A fixed tick count raced: under
  // a loaded run the reconcile outlived 50 setImmediates and the real-divergence test
  // below failed intermittently.
  const settle = () => whenServerCountReconcilesSettle();

  it('a reconcile scheduled before the replace never fires with its stale count; the replace\'s own count is checked instead', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const book = 'book_rc_replace_race';
      await seedBook(book, 1);
      scheduleServerCountReconcile(book, 1); // the select-all-delete's envelope

      beginFullBookReplace(book);
      await seedBook(book, 36); // the paste lands in IDB (startLines overlap → 36 total)
      await vi.advanceTimersByTimeAsync(5_000); // stale timer's window passes mid-replace
      await settle();
      expect(log.error).not.toHaveBeenCalled();
      expect(reportServerCountMismatch).not.toHaveBeenCalled();

      endFullBookReplace(book, 36); // the replace's post-write count
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(log.error).not.toHaveBeenCalled();
      expect(reportServerCountMismatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the gate stays shut while a replace is in flight, and reopens on end', async () => {
    const book = 'book_rc_replace_gate';
    await seedBook(book, 4);

    beginFullBookReplace(book);
    expect(await reconcileServerNodeCount(book, 1)).toMatchObject({
      checked: false, skippedReason: 'full-book replace in flight',
    });

    endFullBookReplace(book); // a failed replace: no count, gate just reopens
    expect((await reconcileServerNodeCount(book, 4)).checked).toBe(true);
  });

  it('the replace\'s count still catches a REAL divergence (the watchdog is not just switched off)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const book = 'book_rc_replace_real';
      await seedBook(book, 28);
      beginFullBookReplace(book);
      endFullBookReplace(book, 5); // server says it kept 5 of 28
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(reportServerCountMismatch).toHaveBeenCalledWith({ bookId: book, localCount: 28, serverCount: 5 });
    } finally {
      vi.useRealTimers();
    }
  });
});
