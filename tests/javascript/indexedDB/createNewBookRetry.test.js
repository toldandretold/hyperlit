/**
 * A new book whose create handshake fails must be handed to the ORDINARY sync
 * queue, not dropped.
 *
 * What this replaces: `storeFallbackSync` wrote failures into a `failedSyncs`
 * object store that the schema never creates (so it always hit its own "store
 * not found" warn and returned), and a `retryFailedSyncs` on an `online`
 * listener read that same non-existent store ("✅ No failedSyncs store found,
 * nothing to retry"). Both ends dead: every failed create logged a line and
 * evaporated. Now the content goes through queueForSync → masterSync →
 * historyLog → retryFailedBatches, the one retry path everything else uses.
 *
 * The second case pins the subtler half: `fireAndForgetSync` resolves EARLY
 * (once the library row exists) and syncs nodes afterwards, so a failure in that
 * tail hit a `reject()` that was already a no-op — it vanished completely.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock factories are hoisted above every top-level binding, so the spy has to
// be created INSIDE the factory and pulled back out via the mocked module below.
vi.mock('../../../resources/js/indexedDB/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateBookTimestamp: vi.fn().mockResolvedValue(undefined),
    syncNodesToPostgreSQL: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  getCurrentUser: vi.fn().mockResolvedValue('alice'),
  getAnonymousToken: vi.fn().mockReturnValue(null),
  refreshCsrfToken: vi.fn(),
}));
vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  syncIndexedDBtoPostgreSQL: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/components/editIndicator.js', () => ({ glowCloudOrange: vi.fn() }));

import { syncNodesToPostgreSQL } from '../../../resources/js/indexedDB/index.js';
import { installFreshIndexedDB, seedStore } from './idbHarness.js';
import { fireAndForgetSync } from '../../../resources/js/SPA/createNewBook';
import { pendingSyncs, initSyncQueueDependencies } from '../../../resources/js/indexedDB/syncQueue/queue';
import { debouncedMasterSync } from '../../../resources/js/indexedDB/syncQueue/master';

const LIBRARY = { book: 'book_1', title: 'Untitled', timestamp: 1000, base_timestamp: 1000, is_owner: true };
const NODE = {
  book: 'book_1', startLine: 100, chunk_id: 0, node_id: 'n-100',
  content: '<h1 id="100" data-node-id="n-100"><br></h1>', hyperlights: [], hypercites: [],
};
const payload = () => ({ bookId: 'book_1', isNewBook: true, libraryRecord: LIBRARY, nodes: [NODE] });

/** The queue keys are `${store}-${book}-${id}` (see queueForSync). */
const queuedStores = () => [...pendingSyncs.keys()].map((k) => k.split('-')[0]).sort();

describe('createNewBook — a failed create is re-queued, never dropped', () => {
  let fetchMock;

  beforeEach(async () => {
    installFreshIndexedDB();
    pendingSyncs.clear();
    initSyncQueueDependencies({ debouncedMasterSync }); // queueForSync arms the drain through this
    syncNodesToPostgreSQL.mockReset().mockResolvedValue(undefined);
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf-token">';
    await seedStore('library', [LIBRARY]);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    debouncedMasterSync.cancel?.(); // the re-queue arms the 3s drain; don't leak it
    pendingSyncs.clear();
  });

  it('queues the library row AND the nodes when bulk-create fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });

    await expect(fireAndForgetSync('book_1', true, payload())).rejects.toThrow(/500/);

    expect(queuedStores()).toEqual(['library', 'nodes']);
    const queuedNode = [...pendingSyncs.values()].find((i) => i.data?.node_id === 'n-100');
    expect(queuedNode.data.content).toContain('<h1');
  });

  it('queues the content when the POST-RESOLVE node sync fails (it used to vanish)', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, text: async () => '',
      json: async () => ({
        success: true,
        library: { book: 'book_1', timestamp: 2000, creator: 'alice', is_owner: true, updated_at: 1, created_at: 1 },
      }),
    });
    syncNodesToPostgreSQL.mockRejectedValue(new Error('node sync exploded'));

    // The handshake itself SUCCEEDS — the library row exists, so consumers are released...
    await expect(fireAndForgetSync('book_1', true, payload())).resolves.toBeUndefined();
    // ...and the failure in the tail still reaches the retry queue.
    await vi.waitFor(() => expect(queuedStores()).toEqual(['library', 'nodes']));
  });

  it('queues nothing when the create succeeds', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, text: async () => '',
      json: async () => ({
        success: true,
        library: { book: 'book_1', timestamp: 2000, creator: 'alice', is_owner: true, updated_at: 1, created_at: 1 },
      }),
    });

    await fireAndForgetSync('book_1', true, payload());
    await vi.waitFor(() => expect(syncNodesToPostgreSQL).toHaveBeenCalled());

    expect(pendingSyncs.size).toBe(0);
  });
});
