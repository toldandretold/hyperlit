/**
 * serverSync/flush must not report "flushed" while work is still unsent.
 *
 * The bug this pins: `debounce().flush()` only runs the pending TIMER. Once the
 * 3s timer has fired, masterSync is mid-drain — flush() returns an already-
 * resolved promise and the round trip is never awaited. The drain also does
 * `pendingSyncs.clear()` at its top, so the old `pendingSyncs.size === 0` fast
 * path ALSO read "nothing to do" while a POST was in flight. Callers then
 * destroyed the local copy (logout wipes historyLog, killing the replay path
 * too) and the edit was gone — the e2ee lifecycle test's vanished sentinel.
 *
 * Real modules: master.js, queue.js, flush.ts, connection.js, fake-indexeddb.
 * Mocked seams: auth, editIndicator, BroadcastListener, reporter, the editor
 * debounces, the parked-batch replay, and global fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/auth', () => ({
  refreshCsrfToken: vi.fn(),
}));
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({
  showStaleTabOverlay: vi.fn(),
}));
vi.mock('../../../resources/js/integrity/reporter', () => ({
  reportIntegrityFailure: vi.fn(),
  reportServerError: vi.fn(),
}));
// The editor debounces are separate subsystems — flush only has to CALL them.
vi.mock('../../../resources/js/footnotes/footnoteAnnotations', () => ({
  flushPendingFootnoteSaves: vi.fn(),
}));
vi.mock('../../../resources/js/divEditor/index', () => ({
  flushInputDebounce: vi.fn(),
  flushAllPendingSaves: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/pageLoad/onlineRetry', () => ({
  retryFailedBatches: vi.fn().mockResolvedValue(undefined),
}));

import { retryFailedBatches } from '../../../resources/js/pageLoad/onlineRetry';
import { installFreshIndexedDB, seedStore, readAll } from './idbHarness.js';
import { flushAllPendingEdits } from '../../../resources/js/indexedDB/serverSync/flush';
import {
  debouncedMasterSync,
  getMasterSyncInFlight,
  initMasterSyncDependencies,
  __resetSyncConcurrencyStateForTests,
} from '../../../resources/js/indexedDB/syncQueue/master';
import { __clearSentSyncTokensForTests } from '../../../resources/js/indexedDB/syncQueue/sentSyncTokens';
import {
  queueForSync,
  pendingSyncs,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';

function makeNode(book, startLine, nodeId, content) {
  return {
    book, startLine, chunk_id: 0, node_id: nodeId, content,
    hyperlights: [], hypercites: [], footnotes: [],
  };
}

/**
 * Watch a promise WITHOUT awaiting it: `.settled` flips the moment it resolves
 * or rejects. (A Promise.race against an already-resolved marker does NOT work
 * here — the marker always wins, so the probe reads "pending" forever.)
 */
function watch(promise) {
  const state = { settled: false, value: undefined };
  promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.value = error; },
  );
  return state;
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('flushAllPendingEdits — durability verdict', () => {
  let releaseFetch;
  let fetchMock;

  beforeEach(() => {
    installFreshIndexedDB();
    pendingSyncs.clear();
    __resetSyncConcurrencyStateForTests();
    __clearSentSyncTokensForTests();
    vi.mocked(retryFailedBatches).mockClear();
    window.isEditing = false;
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf-token">';
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';

    initMasterSyncDependencies({
      book: 'bookA',
      getInitialBookSyncPromise: () => null,
      glowCloudGreen: vi.fn(),
      glowCloudRed: vi.fn(),
      glowCloudLocalSave: vi.fn(),
    });
    initSyncQueueDependencies({ debouncedMasterSync });

    releaseFetch = null;
    fetchMock = vi.fn(() => new Promise((resolve) => {
      releaseFetch = () => resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    debouncedMasterSync.cancel?.();
    delete window.isEditing;
  });

  it('reports synced immediately when there is nothing queued, running or parked', async () => {
    const result = await flushAllPendingEdits();

    expect(result).toEqual({ synced: true, pendingBatches: 0, timedOut: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('WAITS for a drain that is already running — the POST is unacked, so it is not flushed', async () => {
    await seedStore('nodes', [makeNode('bookA', 100, 'n-100', '<h1>the edit</h1>')]);
    queueForSync('nodes', 100, 'update',
      makeNode('bookA', 100, 'n-100', '<h1>the edit</h1>'),
      makeNode('bookA', 100, 'n-100', '<h1></h1>'));

    // Start the drain the way the 3s timer does, WITHOUT awaiting it: the POST
    // is now in flight and the debounce has nothing left to flush.
    const drain = debouncedMasterSync.flush();
    for (let i = 0; i < 50 && fetchMock.mock.calls.length === 0; i++) await tick(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getMasterSyncInFlight()).not.toBeNull();
    expect(pendingSyncs.size).toBe(0); // the drain emptied it at its top — the old fast path's blind spot

    const flushing = flushAllPendingEdits({ budgetMs: 5000 });
    const probe = watch(flushing);
    await tick(400);
    expect(probe.settled).toBe(false); // ← the regression: used to report "flushed" right here

    releaseFetch();
    await drain;

    await expect(flushing).resolves.toEqual({ synced: true, pendingBatches: 0, timedOut: false });
    const log = await readAll('historyLog');
    expect(log.map((e) => e.status)).toEqual(['synced']);
  });

  it('reports NOT synced (without burning the budget) when a batch stays parked', async () => {
    await seedStore('historyLog', [{
      timestamp: Date.now(), bookId: 'bookA', status: 'pending',
      payload: { book: 'bookA', updates: { nodes: [] }, deletions: { nodes: [] } },
    }]);

    const startedAt = Date.now();
    const result = await flushAllPendingEdits({ budgetMs: 10_000 });

    expect(result.synced).toBe(false);
    expect(result.pendingBatches).toBe(1);
    expect(result.timedOut).toBe(false);      // gave up on "no progress possible", not on the clock
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(retryFailedBatches).toHaveBeenCalledTimes(1); // the app's own replay got its one turn
  });

  it('ignores a 409-parked (stale) batch — it never replays, so it must not nag forever', async () => {
    await seedStore('historyLog', [{
      timestamp: Date.now(), bookId: 'bookA', status: 'stale',
      payload: { book: 'bookA', updates: { nodes: [] }, deletions: { nodes: [] } },
    }]);

    await expect(flushAllPendingEdits()).resolves.toEqual({
      synced: true, pendingBatches: 0, timedOut: false,
    });
  });
});
