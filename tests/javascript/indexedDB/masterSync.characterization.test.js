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

import { installFreshIndexedDB, seedStore, readAll, readOne } from './idbHarness.js';
import {
  debouncedMasterSync,
  initMasterSyncDependencies,
} from '../../../resources/js/indexedDB/syncQueue/master';
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
