/**
 * Pins the key-range form of the per-book IDB wipes (serverSync/clear.ts).
 * The old implementation getAllKeys'd then awaited ~one delete round-trip PER
 * RECORD (~7,600 for a mature {u}All feed — the dominant cost of every
 * stale-refresh reload); the range form is one delete per store. The
 * load-bearing risk of a range is the PREFIX COLLISION: the upper bound
 * [bookId, []] must exclude a sibling book whose id merely extends this one
 * ("book_1X" vs "book_1"), because IDB array-key comparison is element-wise.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readAll, readOne } from './idbHarness.js';
import { openDatabase } from '../../../resources/js/indexedDB/core/connection';
import { clearBookDataFromIndexedDB, purgeStaleBookFromIndexedDB } from '../../../resources/js/indexedDB/serverSync/clear';

const TARGET = 'book_1';
const PREFIX_SIBLING = 'book_1X'; // extends TARGET's id — must survive the range delete

describe('per-book range deletes leave a prefix-colliding sibling untouched', () => {
  beforeEach(async () => {
    installFreshIndexedDB();
    await seedStore('nodes', [
      { book: TARGET, startLine: '1', node_id: 'n1', content: '<p>t1</p>' },
      { book: TARGET, startLine: '100.5', node_id: 'n2', content: '<p>t2</p>' },
      { book: PREFIX_SIBLING, startLine: '1', node_id: 's1', content: '<p>s</p>' },
    ]);
    await seedStore('hyperlights', [
      { book: TARGET, hyperlight_id: 'h1', node_id: 'n1' },
      { book: PREFIX_SIBLING, hyperlight_id: 'h2', node_id: 's1' },
    ]);
    await seedStore('hypercites', [
      { book: TARGET, hyperciteId: 'c1', node_id: 'n1' },
      { book: PREFIX_SIBLING, hyperciteId: 'c2', node_id: 's1' },
    ]);
    await seedStore('footnotes', [
      { book: TARGET, footnoteId: 'f1' },
      { book: PREFIX_SIBLING, footnoteId: 'f2' },
    ]);
    await seedStore('bibliography', [
      { book: TARGET, referenceId: 'r1' },
      { book: PREFIX_SIBLING, referenceId: 'r2' },
    ]);
    await seedStore('library', [
      { book: TARGET, timestamp: 111 },
      { book: PREFIX_SIBLING, timestamp: 222 },
    ]);
  });

  it('clearBookDataFromIndexedDB removes exactly the target book', async () => {
    const db = await openDatabase();
    await clearBookDataFromIndexedDB(db, TARGET);

    for (const store of ['nodes', 'hyperlights', 'hypercites', 'footnotes']) {
      const books = (await readAll(store)).map((r) => r.book);
      expect(books, `${store} should keep only the prefix sibling`).toEqual([PREFIX_SIBLING]);
    }
    expect(await readOne('library', TARGET)).toBeUndefined();
    expect(await readOne('library', PREFIX_SIBLING)).toBeTruthy();
    // clearBookDataFromIndexedDB deliberately leaves bibliography alone (only
    // the purge clears it) — both books' rows survive.
    expect((await readAll('bibliography')).length).toBe(2);
  });

  it('purgeStaleBookFromIndexedDB removes exactly the target book (incl. bibliography)', async () => {
    const db = await openDatabase();
    await purgeStaleBookFromIndexedDB(db, TARGET);

    for (const store of ['nodes', 'hyperlights', 'hypercites', 'footnotes', 'bibliography']) {
      const books = (await readAll(store)).map((r) => r.book);
      expect(books, `${store} should keep only the prefix sibling`).toEqual([PREFIX_SIBLING]);
    }
    expect(await readOne('library', TARGET)).toBeUndefined();
    expect(await readOne('library', PREFIX_SIBLING)).toBeTruthy();
  });
});
