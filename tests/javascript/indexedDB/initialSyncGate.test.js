/**
 * The new-book handshake gate inside masterSync's drain must never be able to
 * stop the queue.
 *
 * `NewBookTransition` stores `fireAndForgetSync`'s promise via
 * setInitialBookSyncPromise() so the drain can wait for the library row to exist
 * before pushing nodes into it. That promise REJECTS when the bulk-create fails,
 * and on the SPA-create path it is never cleared — so the old bare `await` meant
 * ONE flaky create wedged the tab permanently: every later drain threw at the
 * gate, BEFORE `pendingSyncs.clear()`, so nothing was ever POSTed again, for any
 * book, with no error surfaced to the user. Typed text just stopped reaching the
 * server. (Observed as the e2ee lifecycle test's sentinel never landing: the DOM
 * held the edit, Postgres never saw a single unified-sync POST for it.)
 *
 * A never-settling handshake is the same failure with no error at all, hence the
 * cap. Pushing early is recoverable — a 404 parks the batch in historyLog and
 * retryFailedBatches replays it — so "proceed" is always the safer branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/auth', () => ({ refreshCsrfToken: vi.fn() }));
vi.mock('../../../resources/js/components/editIndicator.js', () => ({ glowCloudOrange: vi.fn() }));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({ showStaleTabOverlay: vi.fn() }));
vi.mock('../../../resources/js/integrity/reporter', () => ({
  reportIntegrityFailure: vi.fn(),
  reportServerError: vi.fn(),
}));

import { installFreshIndexedDB, seedStore } from './idbHarness.js';
import {
  trackNewBookEstablishment,
  __resetNewBookEstablishmentForTests,
} from '../../../resources/js/utilities/newBookEstablished';
import {
  debouncedMasterSync,
  initMasterSyncDependencies,
  __resetSyncConcurrencyStateForTests,
} from '../../../resources/js/indexedDB/syncQueue/master';
import { __clearSentSyncTokensForTests } from '../../../resources/js/indexedDB/syncQueue/sentSyncTokens';
import {
  queueForSync,
  pendingSyncs,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';

const node = (content) => ({
  book: 'bookA', startLine: 100, chunk_id: 0, node_id: 'n-100', content,
  hyperlights: [], hypercites: [], footnotes: [],
});

/** Seed IDB + queue one edit, with `handshake` installed as the real new-book signal. */
async function queueAnEdit(handshake) {
  if (handshake) trackNewBookEstablishment('bookA', handshake);
  initMasterSyncDependencies({
    book: 'bookA',
    glowCloudGreen: vi.fn(), glowCloudRed: vi.fn(), glowCloudLocalSave: vi.fn(),
  });
  initSyncQueueDependencies({ debouncedMasterSync });
  await seedStore('nodes', [node('<h1>typed</h1>')]);
  queueForSync('nodes', 100, 'update', node('<h1>typed</h1>'), node('<h1></h1>'));
}

describe('masterSync — new-book handshake gate', () => {
  let fetchMock;

  beforeEach(() => {
    installFreshIndexedDB();
    pendingSyncs.clear();
    __resetSyncConcurrencyStateForTests();
    __clearSentSyncTokensForTests();
    __resetNewBookEstablishmentForTests();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf-token">';
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    debouncedMasterSync.cancel?.();
  });

  it('still PUSHES when the handshake rejected — a failed create must not wedge the queue', async () => {
    const rejected = Promise.reject(new Error('bulk-create failed'));
    rejected.catch(() => {}); // the drain is the real handler; this just silences Node
    await queueAnEdit(rejected);

    await debouncedMasterSync.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).nodes[0].content).toBe('<h1>typed</h1>');
    expect(pendingSyncs.size).toBe(0);
  });

  it('does not re-await a handshake it already saw reject (no wedge on later edits either)', async () => {
    const rejected = Promise.reject(new Error('bulk-create failed'));
    rejected.catch(() => {});
    await queueAnEdit(rejected);
    await debouncedMasterSync.flush();

    queueForSync('nodes', 100, 'update', node('<h1>typed again</h1>'), node('<h1>typed</h1>'));
    await debouncedMasterSync.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('WAITS for a handshake that is still running (the library row must exist first)', async () => {
    let settleHandshake;
    const pendingHandshake = new Promise((resolve) => { settleHandshake = resolve; });
    await queueAnEdit(pendingHandshake);

    const drain = debouncedMasterSync.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled(); // still gated

    settleHandshake();
    await drain;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on a handshake that never settles and pushes anyway', async () => {
    await queueAnEdit(new Promise(() => {})); // never settles

    // Fake ONLY setTimeout, and only after the IDB seeding above: fake-indexeddb
    // drives its request queue on the real event loop, so faking everything
    // deadlocks the drain's own reads long before it reaches the gate.
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const drain = debouncedMasterSync.flush();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetchMock).not.toHaveBeenCalled();  // still inside the cap

    await vi.advanceTimersByTimeAsync(2_000);  // past INITIAL_SYNC_WAIT_MS
    await drain;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
