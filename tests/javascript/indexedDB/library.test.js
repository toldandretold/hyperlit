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
  forgetAutoDerivedTitle,
  updateLocalAnnotationsTimestamp,
  advanceBaseTimestamp,
  raiseLocalLibraryTimestamp,
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

  it('syncFirstNodeToTitle renames an "Untitled" book from its first node', async () => {
    await seedStore('library', [
      { book: 'bookA', title: 'Untitled', creator: 'sam' },
      { book: 'bookB', title: 'Already Named' },
    ]);

    expect(await syncFirstNodeToTitle('bookA', '<h1>My <em>Great</em> Book</h1>')).toBe(true);
    const renamed = await readOne('library', 'bookA');
    expect(renamed.title).toBe('My Great Book');
    expect(renamed.author).toBe('sam');           // auto-set from creator
    expect(renamed.bibtex).toContain('My Great Book'); // bibtex regenerated

    // A title a human chose is never touched.
    expect(await syncFirstNodeToTitle('bookB', '<h1>A Heading Of Some Kind</h1>')).toBe(false);
    expect((await readOne('library', 'bookB')).title).toBe('Already Named');

    // Empty text never overwrites the title
    expect(await syncFirstNodeToTitle('bookA', '<h1>   </h1>')).toBe(false);
    expect((await readOne('library', 'bookA')).title).toBe('My Great Book');
  });

  // The old rule was "fire only while the title is exactly Untitled", which made
  // this a one-shot on a 500ms snapshot: type `# The Disp`, pause, keep typing,
  // and the book was permanently called "The Disp". Tracking our own last guess
  // lets the title follow the heading until a human sets one.
  it('syncFirstNodeToTitle keeps following the heading while the user is still typing it', async () => {
    await seedStore('library', [{ book: 'typing', title: 'Untitled', creator: 'sam' }]);

    expect(await syncFirstNodeToTitle('typing', '<h1>The Disp</h1>')).toBe(true);
    expect((await readOne('library', 'typing')).title).toBe('The Disp');

    // …and the rest of the word still lands, instead of being locked out.
    expect(await syncFirstNodeToTitle('typing', '<h1>The Dispossessed</h1>')).toBe(true);
    const done = await readOne('library', 'typing');
    expect(done.title).toBe('The Dispossessed');
    expect(done.bibtex).toContain('The Dispossessed');

    // Re-running with the same text is a no-op, not a pointless write + sync.
    expect(await syncFirstNodeToTitle('typing', '<h1>The Dispossessed</h1>')).toBe(false);
  });

  it('syncFirstNodeToTitle stops for good once a human picks a title', async () => {
    await seedStore('library', [{ book: 'chosen', title: 'Untitled', creator: 'sam' }]);
    await syncFirstNodeToTitle('chosen', '<h1>An Auto Derived Title</h1>');

    // What the edit form / auto-metadata Apply do after writing a chosen title.
    forgetAutoDerivedTitle('chosen');
    const rec = await readOne('library', 'chosen');
    await seedStore('library', [{ ...rec, title: 'The Title I Chose' }]);

    expect(await syncFirstNodeToTitle('chosen', '<h1>Some Later Heading Edit</h1>')).toBe(false);
    expect((await readOne('library', 'chosen')).title).toBe('The Title I Chose');
  });

  // Only things that are structurally NOT a title are refused — a placeholder,
  // a section heading, a nav label, a whole paragraph. "Introduction" matters
  // most: it would get searched against OpenAlex and can match an unrelated real
  // work, minting a confident wrong canonical link.
  it.each([
    ['<h1>Untitled</h1>', 'the placeholder itself'],
    ['<h1>Draft</h1>', 'a placeholder variant'],
    ['<h1>Contents</h1>', 'a structural heading'],
    ['<h1>Introduction</h1>', 'a structural heading'],
    ['<h1>Chapter 3</h1>', 'a chapter heading'],
    ['<h1>MAIN MENU</h1>', 'a navigation label'],
    [`<h1>${'word '.repeat(120)}</h1>`, 'a whole paragraph'],
  ])('syncFirstNodeToTitle refuses %s (%s)', async (html) => {
    await seedStore('library', [{ book: 'junk', title: 'Untitled', creator: 'sam' }]);

    expect(await syncFirstNodeToTitle('junk', html)).toBe(false);
    // Crucially it stays "Untitled", so the NEXT save can still supply a real
    // title — the junk doesn't burn the one shot.
    expect((await readOne('library', 'junk')).title).toBe('Untitled');
  });

  // The server's 5-character floor is about whether a BIBLIOGRAPHIC SEARCH is
  // worth firing, not about what a person may call their book. Applying it here
  // refused "Aura", "Sula", "It" and "1984", and told a user their own heading
  // was "too short".
  it.each([
    ['<h1>Aura</h1>', 'Aura', 'a genuinely short title'],
    ['<h1>It</h1>', 'It', 'a two-letter title'],
    ['<h1>1984</h1>', '1984', 'a numeric title'],
    ['<h1>mmmm</h1>', 'mmmm', "the user's own repeated-character heading"],
  ])('syncFirstNodeToTitle accepts %s (%s)', async (html, expected) => {
    await seedStore('library', [{ book: 'short', title: 'Untitled', creator: 'sam' }]);

    expect(await syncFirstNodeToTitle('short', html)).toBe(true);
    expect((await readOne('library', 'short')).title).toBe(expected);
  });

  it('syncFirstNodeToTitle truncates to 15 words exactly as the server does', async () => {
    // Otherwise IndexedDB and Postgres end up holding different titles.
    await seedStore('library', [{ book: 'longtitle', title: 'Untitled', creator: 'sam' }]);
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');

    expect(await syncFirstNodeToTitle('longtitle', `<h1>${long}</h1>`)).toBe(true);
    const stored = (await readOne('library', 'longtitle')).title;
    expect(stored.split(' ')).toHaveLength(15);
    expect(stored.endsWith('w14...')).toBe(true);
  });

  it('syncFirstNodeToTitle does not execute markup in the node content', async () => {
    // Was a detached div's innerHTML — which fires <img onerror>. Now DOMParser.
    await seedStore('library', [{ book: 'xss', title: 'Untitled', creator: 'sam' }]);
    globalThis.__xssTitleProbe = false;

    await syncFirstNodeToTitle('xss', '<h1>Safe Enough Title<img src=x onerror="globalThis.__xssTitleProbe = true"></h1>');

    expect(globalThis.__xssTitleProbe).toBe(false);
    expect((await readOne('library', 'xss')).title).toBe('Safe Enough Title');
  });

  it('updateLocalAnnotationsTimestamp writes the given timestamp WITHOUT queueing a sync', async () => {
    await seedStore('library', [{ book: 'bookA', title: 'A' }]);
    pendingSyncs.clear();

    await updateLocalAnnotationsTimestamp('bookA', 12345);

    expect((await readOne('library', 'bookA')).annotations_updated_at).toBe(12345);
    expect(pendingSyncs.size).toBe(0);
  });

  it('advanceBaseTimestamp raises base to the server-confirmed version (catch-up after a library write)', async () => {
    await seedStore('library', [{ book: 'bookA', title: 'A', timestamp: 5000, base_timestamp: 1000 }]);

    await advanceBaseTimestamp('bookA', 5000);

    // Base caught up to the confirmed server version so the next node edit won't false-409.
    expect((await readOne('library', 'bookA')).base_timestamp).toBe(5000);
  });

  it('advanceBaseTimestamp is monotonic — never lowers the base, and no-ops on invalid input', async () => {
    await seedStore('library', [{ book: 'bookA', title: 'A', timestamp: 5000, base_timestamp: 5000 }]);

    await advanceBaseTimestamp('bookA', 3000);   // older/stale response — must NOT drag base back
    expect((await readOne('library', 'bookA')).base_timestamp).toBe(5000);

    await advanceBaseTimestamp('bookA', undefined); // non-finite → no-op
    await advanceBaseTimestamp('bookA', 0);         // <= 0 → no-op
    expect((await readOne('library', 'bookA')).base_timestamp).toBe(5000);
  });

  it('advanceBaseTimestamp no-ops (no throw) when the book has no record', async () => {
    await expect(advanceBaseTimestamp('missing', 9999)).resolves.toBeUndefined();
  });

  it('raiseLocalLibraryTimestamp restores the client-sent value after a delete + stale re-pull', async () => {
    // The sub-book skew: the record was torn down with its container and re-pulled
    // from the server BEFORE the queued push landed — local now holds the older
    // value. The sync ACK must restore the value it sent, or every later open
    // reads "server is newer but local has unsynced content" forever.
    await seedStore('library', [{ book: 'bookA', title: 'A', timestamp: 681017 }]);

    await raiseLocalLibraryTimestamp('bookA', 687207);

    expect((await readOne('library', 'bookA')).timestamp).toBe(687207);
  });

  it('raiseLocalLibraryTimestamp is monotonic and no-ops on invalid input or a missing record', async () => {
    await seedStore('library', [{ book: 'bookA', title: 'A', timestamp: 5000 }]);

    await raiseLocalLibraryTimestamp('bookA', 3000);      // a newer local edit exists — keep it
    expect((await readOne('library', 'bookA')).timestamp).toBe(5000);

    await raiseLocalLibraryTimestamp('bookA', undefined); // non-finite → no-op
    await raiseLocalLibraryTimestamp('bookA', 0);         // <= 0 → no-op
    expect((await readOne('library', 'bookA')).timestamp).toBe(5000);

    await expect(raiseLocalLibraryTimestamp('missing', 9999)).resolves.toBeUndefined();
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
