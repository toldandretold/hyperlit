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
  reportLocalCopyIncomplete: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  verbose: { content: vi.fn(), init: vi.fn(), nav: vi.fn(), user: vi.fn() },
}));

import { installFreshIndexedDB, seedStore } from './idbHarness.js';
import {
  reconcileServerNodeCount,
  scheduleServerCountReconcile,
  beginFullBookReplace,
  endFullBookReplace,
  whenServerCountReconcilesSettle,
  shouldRepairShortLocalCopy,
} from '../../../resources/js/indexedDB/serverSync/countReconcile';
import { markLocalCopyPartial } from '../../../resources/js/utilities/localCopyCompleteness';
import { getMasterSyncInFlight } from '../../../resources/js/indexedDB/syncQueue/master';
import { isBackgroundDownloadInProgress } from '../../../resources/js/pageLoad/backgroundDownload';
import { reportServerCountMismatch, reportLocalCopyIncomplete } from '../../../resources/js/integrity/reporter';
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
  localStorage.clear();
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

/*
 * Prod 2026-11-22 (`john2005restorative`): "IndexedDB has 400 nodes, the server reports
 * 3062 … the server acknowledged syncs it did not fully persist" — while the server log
 * for that very sync read before 3062 / after 3062 / deleted 0. The browser's background
 * download had never finished; the cache was a fragment and the watchdog blamed the
 * server for it. A short LOCAL copy is not a divergence.
 */
describe('a short local copy is not a server divergence', () => {
  it('a copy marked partial is reported as local-copy-incomplete, not as a mismatch', async () => {
    await seedBook('book_rc_partial', 4);
    markLocalCopyPartial('book_rc_partial');

    const outcome = await reconcileServerNodeCount('book_rc_partial', 30);

    expect(outcome).toMatchObject({ checked: true, mismatch: false, incomplete: true, localCount: 4, serverCount: 30 });
    expect(reportLocalCopyIncomplete).toHaveBeenCalledWith({
      bookId: 'book_rc_partial', localCount: 4, serverCount: 30,
    });
    expect(reportServerCountMismatch).not.toHaveBeenCalled();
    expect(log.error, 'an incomplete cache is a warning, not an error').not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: an UNMARKED short copy is still a divergence (a refused delete looks like this)', async () => {
    await seedBook('book_rc_unmarked', 4);

    const outcome = await reconcileServerNodeCount('book_rc_unmarked', 30);

    expect(outcome).toMatchObject({ checked: true, mismatch: true });
    expect(reportServerCountMismatch).toHaveBeenCalledTimes(1);
    expect(reportLocalCopyIncomplete).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: the partial marker never excuses a server that holds FEWER rows', async () => {
    // The 2026-11-01 shape (server ate pasted nodes) must flare whatever the marker says.
    await seedBook('book_rc_partial_more', 28);
    markLocalCopyPartial('book_rc_partial_more');

    const outcome = await reconcileServerNodeCount('book_rc_partial_more', 5);

    expect(outcome).toMatchObject({ checked: true, mismatch: true });
    expect(reportServerCountMismatch).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('the divergence message names the side the numbers point at', async () => {
    await seedBook('book_rc_dir_more', 9);
    await reconcileServerNodeCount('book_rc_dir_more', 2);
    expect(log.error.mock.calls[0][0]).toMatch(/server holds FEWER rows/);

    log.error.mockClear();
    await seedBook('book_rc_dir_less', 2);
    await reconcileServerNodeCount('book_rc_dir_less', 9);
    expect(log.error.mock.calls[0][0]).toMatch(/server holds MORE rows/);
  });
});

describe('shouldRepairShortLocalCopy (the page-load check for an UNMARKED fragment)', () => {
  it('local below server → repair, once', async () => {
    await seedBook('book_sr_short', 4);

    expect(await shouldRepairShortLocalCopy('book_sr_short', 30)).toBe(true);
    // The repair ran and the copy is STILL short at the same server count: that is a real
    // divergence for the reconciler, not something another download fixes. No loop.
    expect(await shouldRepairShortLocalCopy('book_sr_short', 30)).toBe(false);
  });

  it('a different server count earns a fresh attempt', async () => {
    await seedBook('book_sr_moved', 4);

    expect(await shouldRepairShortLocalCopy('book_sr_moved', 30)).toBe(true);
    expect(await shouldRepairShortLocalCopy('book_sr_moved', 31)).toBe(true);
  });

  it('a repaired copy clears the attempt, so a LATER shortfall is repaired again', async () => {
    await seedBook('book_sr_healed', 4);
    expect(await shouldRepairShortLocalCopy('book_sr_healed', 6)).toBe(true);

    await seedBook('book_sr_healed', 6); // the download landed
    expect(await shouldRepairShortLocalCopy('book_sr_healed', 6)).toBe(false);

    installFreshIndexedDB();
    await seedBook('book_sr_healed', 4); // lost again
    expect(await shouldRepairShortLocalCopy('book_sr_healed', 6)).toBe(true);
  });

  it('a whole copy, a LONGER copy, an empty copy and an unknown count are all left alone', async () => {
    await seedBook('book_sr_whole', 5);

    expect(await shouldRepairShortLocalCopy('book_sr_whole', 5)).toBe(false);
    expect(await shouldRepairShortLocalCopy('book_sr_whole', 3)).toBe(false); // the reconciler's business
    expect(await shouldRepairShortLocalCopy('book_sr_nothing_cached', 5)).toBe(false);
    expect(await shouldRepairShortLocalCopy('book_sr_whole', null)).toBe(false);
    expect(await shouldRepairShortLocalCopy('book_sr_whole', 0)).toBe(false); // a viewer RLS hides the nodes from
  });

  it('refuses while local edits are unsent — a short copy may be the user\'s own deletions', async () => {
    await seedBook('book_sr_queued', 4);
    pendingSyncs.set('nodes_book_sr_queued_100', {
      store: 'nodes', id: 'book_sr_queued_100', type: 'delete',
      data: { book: 'book_sr_queued', startLine: 100 },
    });
    expect(await shouldRepairShortLocalCopy('book_sr_queued', 30)).toBe(false);

    pendingSyncs.clear();
    await seedStore('historyLog', [{
      id: 951, timestamp: Date.now(), bookId: 'book_sr_queued', status: 'failed',
      payload: { book: 'book_sr_queued', updates: { nodes: [] }, deletions: { nodes: [] } },
    }]);
    expect(await shouldRepairShortLocalCopy('book_sr_queued', 30)).toBe(false);
  });

  it('refuses while a download for the book is already running', async () => {
    await seedBook('book_sr_dl', 4);
    isBackgroundDownloadInProgress.mockReturnValueOnce(true);

    expect(await shouldRepairShortLocalCopy('book_sr_dl', 30)).toBe(false);
  });
});

