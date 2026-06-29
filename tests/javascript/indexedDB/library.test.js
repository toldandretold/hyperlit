/**
 * Pins core/library.js ahead of its TS conversion: storage cleaning, the
 * timestamp updaters (incl. sub-book → parent propagation), Untitled-only
 * title sync, and the offline-books filter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// queue.ts is real — give it a stub master sync.
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));
// bibtexProcessor → auth.js → the root indexedDB barrel → editor import cycle.
// Stub the only name the graph needs.
vi.mock('../../../resources/js/utilities/auth', () => ({
  getCurrentUserId: vi.fn(() => null),
  refreshCsrfToken: vi.fn(),
}));

import { installFreshIndexedDB, seedStore, readOne } from './idbHarness.js';
import {
  cleanLibraryItemForStorage,
  prepareLibraryForIndexedDB,
  getLibraryObjectFromIndexedDB,
  updateBookTimestamp,
  updateAnnotationsTimestamp,
  syncFirstNodeToTitle,
  updateLocalAnnotationsTimestamp,
  getAllOfflineAvailableBooks,
  initLibraryDependencies,
} from '../../../resources/js/indexedDB/core/library';
import {
  pendingSyncs,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';

describe('core/library.js (characterization)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    pendingSyncs.clear();
    initSyncQueueDependencies({ debouncedMasterSync: vi.fn() });
    initLibraryDependencies({ book: 'bookA' });
  });

  it('cleanLibraryItemForStorage strips raw_json and full_library_array', () => {
    const cleaned = cleanLibraryItemForStorage({
      book: 'b', title: 't', raw_json: { nested: true }, full_library_array: [1, 2],
    });
    expect(cleaned).toEqual({ book: 'b', title: 't' });
  });

  it('prepareLibraryForIndexedDB sets raw_json to the cleaned copy and backfills timestamp', () => {
    const prepared = prepareLibraryForIndexedDB({ book: 'b', title: 't', raw_json: { old: true } });
    expect(prepared.raw_json).toEqual({ book: 'b', title: 't' });
    expect(prepared.timestamp).toEqual(expect.any(Number));
  });

  it('prepareLibraryForIndexedDB backfills a null/0 wire timestamp to a real one (wire→store normalize)', () => {
    // ServerLibraryRow allows timestamp: number | null; the store must never hold a falsy timestamp.
    expect(prepareLibraryForIndexedDB({ book: 'b', timestamp: null }).timestamp).toBeGreaterThan(0);
    expect(prepareLibraryForIndexedDB({ book: 'b', timestamp: 0 }).timestamp).toBeGreaterThan(0);
  });

  it('getLibraryObjectFromIndexedDB returns the record, and null for falsy/invalid input', async () => {
    await seedStore('library', [{ book: 'bookA', title: 'A' }]);
    expect(await getLibraryObjectFromIndexedDB('bookA')).toMatchObject({ title: 'A' });
    expect(await getLibraryObjectFromIndexedDB(null)).toBeNull();
    expect(await getLibraryObjectFromIndexedDB({})).toBeNull();
  });

  it('updateBookTimestamp creates a stub record when missing and queues the update', async () => {
    await updateBookTimestamp('bookA');

    const record = await readOne('library', 'bookA');
    expect(record).toEqual({
      book: 'bookA',
      timestamp: expect.any(Number),
      title: 'bookA',
    });
    const queued = pendingSyncs.get('library-bookA-bookA');
    expect(queued.type).toBe('update');
    expect(queued.originalData).toBeNull(); // no prior record
  });

  it('updateBookTimestamp bumps `timestamp` but PRESERVES `base_timestamp` (concurrency base)', async () => {
    // A book pulled from the server has base_timestamp = the server version it last knew.
    await seedStore('library', [{ book: 'bookA', title: 'X', timestamp: 1000, base_timestamp: 1000 }]);

    await updateBookTimestamp('bookA');

    const record = await readOne('library', 'bookA');
    // Local edit advances the display/last-modified timestamp...
    expect(record.timestamp).toBeGreaterThan(1000);
    // ...but must NOT touch the concurrency base, or the server could never detect that this
    // client edited an out-of-date version (the whole bug this guards).
    expect(record.base_timestamp).toBe(1000);
    // And the queued library record carries the un-bumped base for the sync payload.
    expect(pendingSyncs.get('library-bookA-bookA').data.base_timestamp).toBe(1000);
  });

  it('updateBookTimestamp on a SUB-book also touches the parent book', async () => {
    await updateBookTimestamp('book_parent/Fn7');

    expect(await readOne('library', 'book_parent/Fn7')).toBeTruthy();
    // Recursion to the parent is fire-and-forget — poll via the queue
    await new Promise(r => setTimeout(r, 20));
    expect(await readOne('library', 'book_parent')).toBeTruthy();
  });

  it('updateAnnotationsTimestamp stamps annotations_updated_at and queues with the original', async () => {
    await seedStore('library', [{ book: 'bookA', title: 'A' }]);

    const ok = await updateAnnotationsTimestamp('bookA');

    expect(ok).toBe(true);
    expect((await readOne('library', 'bookA')).annotations_updated_at).toEqual(expect.any(Number));
    const queued = pendingSyncs.get('library-bookA-bookA');
    expect(queued.originalData.annotations_updated_at).toBeUndefined();
    // Returns false (not an error) when there is no record
    expect(await updateAnnotationsTimestamp('missing')).toBe(false);
  });

  it('syncFirstNodeToTitle only renames books still called "Untitled"', async () => {
    await seedStore('library', [
      { book: 'bookA', title: 'Untitled', creator: 'sam' },
      { book: 'bookB', title: 'Already Named' },
    ]);

    expect(await syncFirstNodeToTitle('bookA', '<h1>My <em>Great</em> Book</h1>')).toBe(true);
    const renamed = await readOne('library', 'bookA');
    expect(renamed.title).toBe('My Great Book');
    expect(renamed.author).toBe('sam');           // auto-set from creator
    expect(renamed.bibtex).toContain('My Great Book'); // bibtex regenerated

    expect(await syncFirstNodeToTitle('bookB', '<h1>Nope</h1>')).toBe(false);
    expect((await readOne('library', 'bookB')).title).toBe('Already Named');

    // Empty text never overwrites the title
    expect(await syncFirstNodeToTitle('bookA', '<h1>   </h1>')).toBe(false);
  });

  it('updateLocalAnnotationsTimestamp writes the given timestamp WITHOUT queueing a sync', async () => {
    await seedStore('library', [{ book: 'bookA', title: 'A' }]);
    pendingSyncs.clear();

    await updateLocalAnnotationsTimestamp('bookA', 12345);

    expect((await readOne('library', 'bookA')).annotations_updated_at).toBe(12345);
    expect(pendingSyncs.size).toBe(0);
  });

  it('getAllOfflineAvailableBooks requires nodes, drops synthetic books, sorts newest first', async () => {
    await seedStore('library', [
      { book: 'old', title: 'Old', timestamp: 100 },
      { book: 'new', title: 'New', timestamp: 200 },
      { book: 'no-nodes', title: 'Empty', timestamp: 300 },
      { book: 'most-recent', title: 'synthetic', timestamp: 400 },
    ]);
    await seedStore('nodes', [
      { book: 'old', startLine: 100, chunk_id: 0, content: 'x' },
      { book: 'new', startLine: 100, chunk_id: 0, content: 'y' },
      { book: 'most-recent', startLine: 100, chunk_id: 0, content: 's' },
    ]);

    const books = await getAllOfflineAvailableBooks();
    expect(books.map(b => b.book)).toEqual(['new', 'old']);
  });
});
