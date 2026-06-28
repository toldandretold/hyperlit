/**
 * Pins the stale-recovery hard cleanse used by the 409 STALE_DATA overlay button.
 *
 * The bug this guards: a bare window.location.reload() left the stale book's
 * IndexedDB copy in place, so reload re-rendered the same stale data and the 409
 * looped forever. hardRefreshStaleBook() must, for the offending book, drop its
 * pending syncs + clear its IndexedDB data + clear the browser caches BEFORE
 * reloading — and must always reload even if a cleanse step throws.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const clearPendingSyncsForBook = vi.fn();
const purgeStaleBookFromIndexedDB = vi.fn().mockResolvedValue(undefined);
const clearBrowserCache = vi.fn().mockResolvedValue(undefined);
const openDatabase = vi.fn().mockResolvedValue({ __db: true });

vi.mock('../../../resources/js/indexedDB/syncQueue/queue', () => ({
  clearPendingSyncsForBook,
}));
vi.mock('../../../resources/js/indexedDB/types', () => ({
  asBookId: (s) => s,
}));
vi.mock('../../../resources/js/indexedDB/core/connection.js', () => ({
  openDatabase,
}));
vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  purgeStaleBookFromIndexedDB,
}));
vi.mock('../../../resources/js/components/userContainer/cache', () => ({
  clearBrowserCache,
}));

import { hardRefreshStaleBook } from '../../../resources/js/utilities/staleRecovery';

describe('hardRefreshStaleBook', () => {
  let reload;

  beforeEach(() => {
    vi.clearAllMocks();
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { reload },
      writable: true,
      configurable: true,
    });
  });

  it('PURGES the offending book (incl. historyLog) then reloads', async () => {
    await hardRefreshStaleBook('book_123');

    expect(clearPendingSyncsForBook).toHaveBeenCalledWith('book_123');
    // Must use the aggressive purge (which clears historyLog) — NOT the plain clear,
    // or the doomed batch replays the 409 forever.
    expect(purgeStaleBookFromIndexedDB).toHaveBeenCalledWith({ __db: true }, 'book_123');
    expect(clearBrowserCache).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still clears caches + reloads when no bookId is given', async () => {
    await hardRefreshStaleBook(undefined);

    expect(clearPendingSyncsForBook).not.toHaveBeenCalled();
    expect(purgeStaleBookFromIndexedDB).not.toHaveBeenCalled();
    expect(clearBrowserCache).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('always reloads even if a purge step throws', async () => {
    purgeStaleBookFromIndexedDB.mockRejectedValueOnce(new Error('idb boom'));

    await hardRefreshStaleBook('book_123');

    // The purge failed, but the user must not be left stuck on the stale overlay.
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
