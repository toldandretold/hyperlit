/**
 * Characterization of the sync orchestration: queueForSync → debouncedMasterSync
 * → POST /api/db/unified-sync, with historyLog bookkeeping.
 *
 * The payload shape asserted in the first test IS the client→server contract —
 * the TypeScript migration must not move a single field of it.
 *
 * Real modules: master.js, queue.js, connection.js, freshNodeFilter.js,
 * hydration/rebuild.js (dynamic import), fake-indexeddb. Mocked seams: auth,
 * editIndicator, BroadcastListener, integrity reporter, and global fetch.
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

import { showStaleTabOverlay } from '../../../resources/js/utilities/BroadcastListener';
import { installFreshIndexedDB, seedStore, readAll, readOne } from './idbHarness.js';
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

function makeNode(book, startLine, nodeId, content) {
  return {
    book,
    startLine,
    chunk_id: 0,
    node_id: nodeId,
    content,
    hyperlights: [],
    hypercites: [],
    footnotes: [],
  };
}

describe('debouncedMasterSync (characterization)', () => {
  let fetchMock;
  let glowGreen;
  let glowRed;
  let glowLocalSave;

  beforeEach(() => {
    installFreshIndexedDB();
    pendingSyncs.clear();
    __resetSyncConcurrencyStateForTests();
    __clearSentSyncTokensForTests();
    sessionStorage.removeItem('pending_new_book_sync');
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf-token">';
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';

    glowGreen = vi.fn();
    glowRed = vi.fn();
    glowLocalSave = vi.fn();
    initMasterSyncDependencies({
      book: 'bookA',
      getInitialBookSyncPromise: () => null,
      glowCloudGreen: glowGreen,
      glowCloudRed: glowRed,
      glowCloudLocalSave: glowLocalSave,
    });
    initSyncQueueDependencies({ debouncedMasterSync });

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    debouncedMasterSync.cancel?.();
  });

  it('POSTs the pinned unified-sync payload, re-reading node content fresh from IDB', async () => {
    // The IDB copy is NEWER than the queued copy — the sync must send the IDB copy.
    await seedStore('nodes', [makeNode('bookA', 100, 'n-100', '<p>fresh from IDB</p>')]);
    queueForSync(
      'nodes',
      100,
      'update',
      makeNode('bookA', 100, 'n-100', '<p>stale queued copy</p>'),
      makeNode('bookA', 100, 'n-100', '<p>the original</p>'),
    );

    await debouncedMasterSync.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/db/unified-sync');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': 'test-csrf-token',
    });

    // ⚠️ CLIENT→SERVER CONTRACT — field-for-field.
    expect(JSON.parse(init.body)).toEqual({
      book: 'bookA',
      nodes: [{
        book: 'bookA',
        startLine: 100,
        node_id: 'n-100',
        content: '<p>fresh from IDB</p>', // re-read won over the queued copy
        hyperlights: [],
        hypercites: [],
        footnotes: [],
        chunk_id: 0,
      }],
      hypercites: [],
      hyperlights: [],
      hyperlightDeletions: [],
      footnotes: [],
      footnoteDeletions: [],
      bibliography: [],
      bibliographyDeletions: [],
      library: null,
      // Client-generated write id for lost-ACK self-conflict detection: the server
      // stores it beside the library timestamp it produces and echoes it back in a
      // STALE_DATA 409 as server_sync_token. See syncQueue/sentSyncTokens.ts.
      sync_token: expect.any(String),
    });

    // historyLog bookkeeping: queued (not re-read) state as update, original as deletion
    const logs = await readAll('historyLog');
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('synced');
    expect(logs[0].bookId).toBe('bookA');
    expect(logs[0].payload.updates.nodes[0].content).toBe('<p>stale queued copy</p>');
    expect(logs[0].payload.deletions.nodes[0].content).toBe('<p>the original</p>');

    expect(pendingSyncs.size).toBe(0);
    expect(glowGreen).toHaveBeenCalled();
  });

  it('sends base_timestamp (the un-bumped concurrency base) and advances it from the server response', async () => {
    // Library pulled at server version 1000; a later local edit bumped `timestamp` to 4000
    // but base stays 1000 (what the server last confirmed).
    await seedStore('library', [{ book: 'bookA', title: 'X', timestamp: 4000, base_timestamp: 1000 }]);
    await seedStore('nodes', [makeNode('bookA', 100, 'n-100', '<p>edit</p>')]);
    queueForSync('nodes', 100, 'update', makeNode('bookA', 100, 'n-100', '<p>edit</p>'), null);

    // Server accepts and reports its authoritative post-write version.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, server_timestamp: 5000 }) });

    await debouncedMasterSync.flush();

    // The POST carries the BASE (1000), not the bumped display timestamp (4000).
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.base_timestamp).toBe(1000);

    // After success, the local base advances to the server's authoritative version so the
    // next edit doesn't spuriously 409 against an outdated base.
    const lib = await readOne('library', 'bookA');
    expect(lib.base_timestamp).toBe(5000);
  });

  it('on a 5xx: marks the historyLog batch failed and glows red with savedLocally', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'kaboom' });
    await seedStore('nodes', [makeNode('bookB', 100, 'nB-100', '<p>b</p>')]);
    queueForSync('nodes', 100, 'update', makeNode('bookB', 100, 'nB-100', '<p>b</p>'), null);

    await debouncedMasterSync.flush();

    const logs = await readAll('historyLog');
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('failed');
    expect(glowRed).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, savedLocally: true }),
    );
    expect(glowGreen).not.toHaveBeenCalled();
  });

  it('offline: skips fetch, keeps the batch pending in historyLog, glows local-save', async () => {
    const onLineSpy = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      await seedStore('nodes', [makeNode('bookC', 100, 'nC-100', '<p>c</p>')]);
      queueForSync('nodes', 100, 'update', makeNode('bookC', 100, 'nC-100', '<p>c</p>'), null);

      await debouncedMasterSync.flush();

      expect(fetchMock).not.toHaveBeenCalled();
      const logs = await readAll('historyLog');
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe('pending');
      expect(glowLocalSave).toHaveBeenCalled();
    } finally {
      onLineSpy.mockRestore();
    }
  });

  it('drops synthetic homepage books without syncing', async () => {
    queueForSync('nodes', 100, 'update', makeNode('most-recent', 100, 'n-1', '<p>x</p>'), null);

    await debouncedMasterSync.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readAll('historyLog')).toEqual([]);
    expect(pendingSyncs.size).toBe(0);
  });

  // ── Self-conflict-aware 409 STALE_DATA handling ────────────────────────────
  // A single client editing its OWN book twice in quick succession can send a
  // base_timestamp that lags a timestamp the client itself just produced. The server
  // 409s it. That must NOT hard-block the user (it's not another device) — the client
  // fast-forwards its base and retries once. A 409 for a timestamp we've never seen
  // (a real other-device write) still blocks.

  it('SELF-conflict 409 (server_timestamp already acked): fast-forwards base + retries once, no overlay', async () => {
    showStaleTabOverlay.mockClear();
    await seedStore('library', [{ book: 'bookSelf', title: 'X', timestamp: 4000, base_timestamp: 1000 }]);

    // Sync #1 succeeds → the client records acked server_timestamp = 5000.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, server_timestamp: 5000 }) });
    await seedStore('nodes', [makeNode('bookSelf', 100, 's-100', '<p>e1</p>')]);
    queueForSync('nodes', 100, 'update', makeNode('bookSelf', 100, 's-100', '<p>e1</p>'), null);
    await debouncedMasterSync.flush();

    // Sync #2: server 409s STALE_DATA reporting server_timestamp=5000 — a value WE already
    // acked → self-conflict. The retry (after fast-forward) succeeds with 6000.
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'STALE_DATA', message: 'stale', server_timestamp: 5000 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, server_timestamp: 6000 }) });
    await seedStore('nodes', [makeNode('bookSelf', 101, 's-101', '<p>e2</p>')]);
    queueForSync('nodes', 101, 'update', makeNode('bookSelf', 101, 's-101', '<p>e2</p>'), null);
    await debouncedMasterSync.flush();

    // The retried POST carried the fast-forwarded base (5000).
    const lastBody = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(lastBody.base_timestamp).toBe(5000);
    // No hard-block overlay for the user's own edit.
    expect(showStaleTabOverlay).not.toHaveBeenCalled();
    // Base advanced to the retry's authoritative version.
    expect((await readOne('library', 'bookSelf')).base_timestamp).toBe(6000);
    // The 2nd edit's batch is synced, not parked stale.
    const logs = (await readAll('historyLog')).filter(l => l.bookId === 'bookSelf');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every(l => l.status === 'synced')).toBe(true);
  });

  it('REAL 409 (never acked AND server content differs): blocks with overlay, no unified-sync retry', async () => {
    showStaleTabOverlay.mockClear();
    await seedStore('library', [{ book: 'bookReal', title: 'X', timestamp: 4000, base_timestamp: 1000 }]);

    // Sync #1 succeeds → acked = 5000.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, server_timestamp: 5000 }) });
    await seedStore('nodes', [makeNode('bookReal', 100, 'r-100', '<p>e1</p>')]);
    queueForSync('nodes', 100, 'update', makeNode('bookReal', 100, 'r-100', '<p>e1</p>'), null);
    await debouncedMasterSync.flush();

    // Sync #2: 409 at server_timestamp=9000 — never acked. The lost-ACK content check GETs the
    // server's current r-101; a DIFFERENT device changed it → content differs → genuine remote
    // edit. Must block, and must NOT retry the unified-sync POST (retrying would clobber it).
    let posts = 0;
    fetchMock.mockImplementation((url) => {
      if (String(url).includes('/api/db/unified-sync')) {
        posts++;
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'STALE_DATA', message: 'stale', server_timestamp: 9000 }) });
      }
      // read-only content-check endpoint: server's r-101 is the OTHER device's version.
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ nodes: [{ book: 'bookReal', startLine: 101, chunk_id: 0, node_id: 'r-101', content: '<p>OTHER DEVICE wrote this</p>' }] }) });
    });
    await seedStore('nodes', [makeNode('bookReal', 101, 'r-101', '<p>e2</p>')]);
    queueForSync('nodes', 101, 'update', makeNode('bookReal', 101, 'r-101', '<p>e2</p>'), null);
    await debouncedMasterSync.flush();

    // Exactly ONE unified-sync POST for sync #2 (the content-check GET is separate; no retry).
    expect(posts).toBe(1);
    // The block overlay is shown via an async dynamic import().then() — wait for it (else the
    // assertion races the microtask, flaking under full-suite timing).
    await vi.waitFor(() => expect(showStaleTabOverlay).toHaveBeenCalled());
  });

  // The lost-ACK case (a network blip committed our write but dropped the response, so our
  // base never advanced and the timestamp was never acked): the ack-match guard can't fire,
  // but the server's CURRENT content for our node equals what we're writing → our own write →
  // recover silently instead of showing the discard overlay.
  it('LOST-ACK 409 (never acked but server content MATCHES): silently recovers, no overlay', async () => {
    showStaleTabOverlay.mockClear();
    await seedStore('library', [{ book: 'bookLost', title: 'X', timestamp: 4000, base_timestamp: 1000 }]);

    // Sync #1 succeeds → acked = 5000.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, server_timestamp: 5000 }) });
    await seedStore('nodes', [makeNode('bookLost', 100, 'l-100', '<p>e1</p>')]);
    queueForSync('nodes', 100, 'update', makeNode('bookLost', 100, 'l-100', '<p>e1</p>'), null);
    await debouncedMasterSync.flush();

    // Sync #2: 409 at 9000 (never acked). The content-check GET shows the server ALREADY holds
    // our l-101 content (the lost-ACK write). → fast-forward base to 9000 + retry once (→ 9500).
    let posts = 0;
    fetchMock.mockImplementation((url) => {
      if (String(url).includes('/api/db/unified-sync')) {
        posts++;
        return posts === 1
          ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'STALE_DATA', message: 'stale', server_timestamp: 9000 }) })
          : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, server_timestamp: 9500 }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ nodes: [{ book: 'bookLost', startLine: 101, chunk_id: 0, node_id: 'l-101', content: '<p>e2</p>' }] }) });
    });
    await seedStore('nodes', [makeNode('bookLost', 101, 'l-101', '<p>e2</p>')]);
    queueForSync('nodes', 101, 'update', makeNode('bookLost', 101, 'l-101', '<p>e2</p>'), null);
    await debouncedMasterSync.flush();

    // Recovered silently: one 409 POST + one retry POST, no overlay.
    expect(posts).toBe(2);
    expect(showStaleTabOverlay).not.toHaveBeenCalled();
    // The retry carried the fast-forwarded base (9000) and the base advanced to 9500.
    const postCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/db/unified-sync'));
    expect(JSON.parse(postCalls.at(-1)[1].body).base_timestamp).toBe(9000);
    expect((await readOne('library', 'bookLost')).base_timestamp).toBe(9500);
    const logs = (await readAll('historyLog')).filter(l => l.bookId === 'bookLost');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every(l => l.status === 'synced')).toBe(true);
  });

  // The lost-ACK case the CONTENT check cannot rescue (the 2026-07 paste incident): a
  // network blip commits batch N server-side and drops the response, and the paste flow
  // keeps mutating the same node — so batch N+1 carries NEWER content than the committed
  // snapshot and the content compare correctly refuses to vouch for it. The sync token
  // still proves it: the 409 echoes the server_sync_token stored by batch N's library
  // write, and that token is in this client's sent ledger → own write → recover silently.
  it('LOST-ACK 409 with drifted content but OUR sync token: silently recovers, no overlay', async () => {
    showStaleTabOverlay.mockClear();
    await seedStore('library', [{ book: 'bookTok', title: 'X', timestamp: 4000, base_timestamp: 1000 }]);

    // Sync #1 = the committed-but-lost write's SIBLING from this client (any earlier POST):
    // we only need it to capture a token this client actually sent. It "fails" on the wire
    // (network blip) AFTER the server committed it — so nothing is acked, base stays 1000.
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
    await seedStore('nodes', [makeNode('bookTok', 100, 't-100', '<p>pasted v1</p>')]);
    queueForSync('nodes', 100, 'update', makeNode('bookTok', 100, 't-100', '<p>pasted v1</p>'), null);
    await debouncedMasterSync.flush();
    const lostToken = JSON.parse(fetchMock.mock.calls[0][1].body).sync_token;
    expect(typeof lostToken).toBe('string');

    // The node keeps changing locally (paste flow's follow-up saves) → content drifts.
    await seedStore('nodes', [makeNode('bookTok', 100, 't-100', '<p>pasted v2 (drifted)</p>')]);

    // Sync #2: 409 at 9000 (never acked) echoing OUR token. The server's stored content is
    // still v1 — the content check would see a mismatch — but the token match must win.
    // No content-check GET should even be needed.
    let posts = 0;
    let contentCheckGets = 0;
    fetchMock.mockImplementation((url) => {
      if (String(url).includes('/api/db/unified-sync')) {
        posts++;
        return posts === 1
          ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'STALE_DATA', message: 'stale', server_timestamp: 9000, server_sync_token: lostToken }) })
          : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, server_timestamp: 9500 }) });
      }
      contentCheckGets++;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ nodes: [{ book: 'bookTok', startLine: 100, chunk_id: 0, node_id: 't-100', content: '<p>pasted v1</p>' }] }) });
    });
    queueForSync('nodes', 100, 'update', makeNode('bookTok', 100, 't-100', '<p>pasted v2 (drifted)</p>'), null);
    await debouncedMasterSync.flush();

    // Recovered silently on the token alone: 409 POST + retry POST, no read-only GET, no overlay.
    expect(posts).toBe(2);
    expect(contentCheckGets).toBe(0);
    expect(showStaleTabOverlay).not.toHaveBeenCalled();
    const postCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/db/unified-sync'));
    expect(JSON.parse(postCalls.at(-1)[1].body).base_timestamp).toBe(9000);
    expect((await readOne('library', 'bookTok')).base_timestamp).toBe(9500);
  });

  // A foreign token (another device's write id) must NOT unlock recovery by itself —
  // with the ledger missing it and content differing, the hard block stands.
  it('409 with a token we never sent AND drifted content: still blocks with overlay', async () => {
    showStaleTabOverlay.mockClear();
    await seedStore('library', [{ book: 'bookForeign', title: 'X', timestamp: 4000, base_timestamp: 1000 }]);

    let posts = 0;
    fetchMock.mockImplementation((url) => {
      if (String(url).includes('/api/db/unified-sync')) {
        posts++;
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'STALE_DATA', message: 'stale', server_timestamp: 9000, server_sync_token: 'someone-elses-token' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ nodes: [{ book: 'bookForeign', startLine: 100, chunk_id: 0, node_id: 'f-100', content: '<p>OTHER DEVICE wrote this</p>' }] }) });
    });
    await seedStore('nodes', [makeNode('bookForeign', 100, 'f-100', '<p>mine</p>')]);
    queueForSync('nodes', 100, 'update', makeNode('bookForeign', 100, 'f-100', '<p>mine</p>'), null);
    await debouncedMasterSync.flush();

    expect(posts).toBe(1); // no retry — retrying would clobber the other device's write
    await vi.waitFor(() => expect(showStaleTabOverlay).toHaveBeenCalled());
  });

  // ── Pending new-book: exempt from the optimistic-concurrency (stale) check ──
  // A brand-new book isn't settled on the server yet (marked by `pending_new_book_sync`).
  // Applying the base check to it races the multiple paths that bump the server timestamp →
  // false 409s. While pending, the sync must send a FALSY server base (null base_timestamp AND
  // null library.timestamp on the wire) so the server skips the check.

  it('pending new book: sends null base_timestamp AND null library.timestamp on the wire', async () => {
    sessionStorage.setItem('pending_new_book_sync', JSON.stringify({ bookId: 'bookA', isNewBook: true }));
    try {
      await seedStore('library', [{ book: 'bookA', title: 'X', timestamp: 4000, base_timestamp: 1000 }]);
      await seedStore('nodes', [makeNode('bookA', 100, 'n-100', '<p>e</p>')]);
      // Queue a library update (title sync) too, so we can assert its wire timestamp is nulled.
      queueForSync('nodes', 100, 'update', makeNode('bookA', 100, 'n-100', '<p>e</p>'), null);
      queueForSync('library', 'lib', 'update', { book: 'bookA', title: 'X', timestamp: 4000, base_timestamp: 1000 }, null);

      await debouncedMasterSync.flush();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Both levers the server reads (UnifiedSyncController :104) are falsy → stale check skipped.
      expect(body.base_timestamp ?? null).toBeNull();
      if (body.library) expect(body.library.timestamp ?? null).toBeNull();
    } finally {
      sessionStorage.removeItem('pending_new_book_sync');
    }
  });

  it('non-pending book: sends the real base_timestamp (check still applies)', async () => {
    sessionStorage.removeItem('pending_new_book_sync');
    await seedStore('library', [{ book: 'bookA', title: 'X', timestamp: 4000, base_timestamp: 1000 }]);
    await seedStore('nodes', [makeNode('bookA', 100, 'n-100', '<p>e</p>')]);
    queueForSync('nodes', 100, 'update', makeNode('bookA', 100, 'n-100', '<p>e</p>'), null);

    await debouncedMasterSync.flush();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).base_timestamp).toBe(1000);
  });

  it('groups queued items by book: one POST per book (sub-books sync independently)', async () => {
    await seedStore('nodes', [
      makeNode('bookA', 100, 'n-100', '<p>parent</p>'),
      makeNode('book_bookA/Fn1', 100, 'sub-100', '<p>footnote</p>'),
    ]);
    queueForSync('nodes', 100, 'update', makeNode('bookA', 100, 'n-100', '<p>parent</p>'), null);
    queueForSync('nodes', 100, 'update', makeNode('book_bookA/Fn1', 100, 'sub-100', '<p>footnote</p>'), null);

    await debouncedMasterSync.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const books = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).book);
    expect(books).toEqual(['bookA', 'book_bookA/Fn1']);
  });
});
