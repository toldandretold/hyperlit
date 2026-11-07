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
import { reconcileServerNodeCount } from '../../../resources/js/indexedDB/serverSync/countReconcile';
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
