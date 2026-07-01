/**
 * New-book base_timestamp handshake (createNewBook.fireAndForgetSync).
 *
 * A brand-new book is created LOCALLY before it exists on the server. Its
 * base_timestamp (the optimistic-concurrency token) must be adopted from the
 * server's confirmed library.timestamp once the create-sync completes — in EVERY
 * reconciliation branch, including the "local content changed during sync" early
 * return that a fast editor hits. Otherwise base stays frozen at createdAt while
 * the server moved ahead, and the VERY FIRST edit falsely 409s (STALE_DATA) and
 * hard-blocks the user. This pins that adoption for the fast-editor branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Keep the real IDB barrel, but make updateBookTimestamp a no-op so we control the
// record's `timestamp` deterministically (else its Date.now() bump races syncStartTime).
vi.mock('../../../resources/js/indexedDB/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, updateBookTimestamp: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  getCurrentUser: vi.fn().mockResolvedValue('alice'),
  getAnonymousToken: vi.fn().mockReturnValue(null),
}));
vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  syncIndexedDBtoPostgreSQL: vi.fn().mockResolvedValue(undefined),
}));

import { installFreshIndexedDB, seedStore, readOne } from './idbHarness.js';
import { fireAndForgetSync } from '../../../resources/js/SPA/createNewBook';

// `timestamp` far in the future so `currentLocal.timestamp > syncStartTime` (real Date.now())
// is deterministically true → the fast-editor early-return branch fires.
const FAR_FUTURE = 9_000_000_000_000_000;

describe('createNewBook base_timestamp handshake (fast-editor branch)', () => {
  let fetchMock;

  beforeEach(() => {
    installFreshIndexedDB();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf-token">';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  function mockBulkCreate(serverTimestamp) {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        success: true,
        library: { book: 'book_1', timestamp: serverTimestamp, creator: 'alice', is_owner: true, updated_at: 1, created_at: 1 },
      }),
    });
  }

  it('adopts the server base even when local content changed during the create-sync', async () => {
    // base frozen at createdAt (1000), local timestamp already bumped by a fast edit.
    await seedStore('library', [{ book: 'book_1', title: 'Untitled', timestamp: FAR_FUTURE, base_timestamp: 1000, is_owner: true }]);
    mockBulkCreate(5000); // server confirmed version

    await fireAndForgetSync('book_1', true, { nodes: [] });

    // Concurrency base advanced to the server's confirmed version → first edit won't 409.
    expect((await readOne('library', 'book_1')).base_timestamp).toBe(5000);
    // Local content (the future timestamp) is preserved (branch's original purpose).
    expect((await readOne('library', 'book_1')).timestamp).toBe(FAR_FUTURE);
  });

  it('is monotonic: never lowers an already-higher base', async () => {
    await seedStore('library', [{ book: 'book_1', title: 'Untitled', timestamp: FAR_FUTURE, base_timestamp: 8000, is_owner: true }]);
    mockBulkCreate(5000); // server reports an OLDER version than our base

    await fireAndForgetSync('book_1', true, { nodes: [] });

    expect((await readOne('library', 'book_1')).base_timestamp).toBe(8000); // unchanged
  });
});
