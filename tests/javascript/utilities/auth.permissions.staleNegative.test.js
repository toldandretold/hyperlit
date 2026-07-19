// @vitest-environment happy-dom
/**
 * canUserEditBook — the stale-negative guard.
 *
 * A local IDB library record can lag reality (cached while logged out, or a
 * survivor of partial browser storage eviction) and its is_owner:false locked
 * the real owner out of edit mode. Rule: before trusting "no" from LOCAL data
 * while online, confirm with the server — its is_owner is authoritative.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getLibraryObjectFromIndexedDB = vi.fn();
vi.mock('../../../resources/js/indexedDB/index', () => ({
  getLibraryObjectFromIndexedDB: (...args) => getLibraryObjectFromIndexedDB(...args),
  clearDatabase: vi.fn(),
}));
const getCurrentUser = vi.fn(async () => ({ name: 'toldandretold' }));
vi.mock('../../../resources/js/utilities/auth/session', () => ({
  initializeAuth: vi.fn(async () => {}),
  getCurrentUser: (...args) => getCurrentUser(...args),
}));

import { canUserEditBook, clearEditPermissionCache } from '../../../resources/js/utilities/auth/permissions';
import { authState } from '../../../resources/js/utilities/auth/state';

const BOOK = 'book_stale_perm_test';
let fetchCalls;

beforeEach(() => {
  clearEditPermissionCache();
  sessionStorage.clear();
  authState.authInitialized = true;
  getLibraryObjectFromIndexedDB.mockReset();
  getCurrentUser.mockReset().mockResolvedValue({ name: 'toldandretold' });
  fetchCalls = [];
  global.fetch = vi.fn(async (url) => {
    fetchCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, library: { book: BOOK, is_owner: true } }),
    };
  });
});

describe('canUserEditBook stale-negative guard', () => {
  it('re-checks the server when the LOCAL record says no — server is_owner wins', async () => {
    getLibraryObjectFromIndexedDB.mockResolvedValue({ book: BOOK, is_owner: false });
    expect(await canUserEditBook(BOOK)).toBe(true);
    expect(fetchCalls.some(u => u.includes(`/books/${BOOK}/library`))).toBe(true);
    // and the POSITIVE result is what got cached
    expect(await canUserEditBook(BOOK)).toBe(true);
  });

  it('still denies when the server also says no', async () => {
    getLibraryObjectFromIndexedDB.mockResolvedValue({ book: BOOK, is_owner: false });
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, library: { book: BOOK, is_owner: false } }),
    }));
    expect(await canUserEditBook(BOOK)).toBe(false);
  });

  it('does NOT hit the server when the local record already grants edit', async () => {
    getLibraryObjectFromIndexedDB.mockResolvedValue({ book: BOOK, is_owner: true });
    expect(await canUserEditBook(BOOK)).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });
});
