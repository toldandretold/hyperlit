/**
 * Pins utilities/cleanup.js ahead of its TS conversion: full clear, the
 * content-only clear (preserves library/annotations, sweeps sub-books), and
 * the full book delete with its per-store counts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readAll, readOne } from './idbHarness.js';
import {
  clearDatabase,
  clearBookContentFromIndexedDB,
  deleteBookFromIndexedDB,
} from '../../../resources/js/indexedDB/utilities/cleanup';

async function seedTwoBooksWithSubBook() {
  await seedStore('nodes', [
    { book: 'book_x', startLine: 100, chunk_id: 0, node_id: 'x-100', content: '<p>x</p>' },
    { book: 'book_x', startLine: 200, chunk_id: 0, node_id: 'x-200', content: '<p>x2</p>' },
    { book: 'book_x/Fn1', startLine: 100, chunk_id: 0, node_id: 'sub-100', content: '<p>fn</p>' },
    { book: 'book_y', startLine: 100, chunk_id: 0, node_id: 'y-100', content: '<p>y</p>' },
  ]);
  await seedStore('footnotes', [
    { book: 'book_x', footnoteId: 'Fn1', content: 'fx' },
    { book: 'book_y', footnoteId: 'Fn1', content: 'fy' },
  ]);
  await seedStore('bibliography', [
    { book: 'book_x', referenceId: 'Ref1' },
    { book: 'book_y', referenceId: 'Ref1' },
  ]);
  await seedStore('hyperlights', [
    { book: 'book_x', hyperlight_id: 'HL_1', node_id: ['x-100'], charData: {} },
  ]);
  await seedStore('library', [
    { book: 'book_x', title: 'X' },
    { book: 'book_x/Fn1', title: 'X footnote' },
    { book: 'book_y', title: 'Y' },
  ]);
}

describe('utilities/cleanup.js (characterization)', () => {
  beforeEach(async () => {
    installFreshIndexedDB();
    await seedTwoBooksWithSubBook();
  });

  it('clearDatabase empties every store', async () => {
    await clearDatabase();
    for (const store of ['nodes', 'footnotes', 'bibliography', 'hyperlights', 'library']) {
      expect(await readAll(store), store).toEqual([]);
    }
  });

  it('clearBookContentFromIndexedDB clears content + sub-books but keeps library record and annotations', async () => {
    await clearBookContentFromIndexedDB('book_x');

    // book_x content gone, including the sub-book's nodes
    expect((await readAll('nodes')).map(n => n.book)).toEqual(['book_y']);
    expect((await readAll('footnotes')).map(f => f.book)).toEqual(['book_y']);
    expect((await readAll('bibliography')).map(b => b.book)).toEqual(['book_y']);

    // annotations and the MAIN library record survive; sub-book library record goes
    expect(await readAll('hyperlights')).toHaveLength(1);
    expect(await readOne('library', 'book_x')).toMatchObject({ title: 'X' });
    expect(await readOne('library', 'book_x/Fn1')).toBeUndefined();
    expect(await readOne('library', 'book_y')).toMatchObject({ title: 'Y' });
  });

  it('deleteBookFromIndexedDB removes everything for the book (incl. sub-books) and reports counts', async () => {
    const result = await deleteBookFromIndexedDB('book_x');

    expect(result).toEqual({
      success: true,
      bookId: 'book_x',
      deleted: {
        nodes: 3,        // 2 main + 1 sub-book
        hyperlights: 1,
        hypercites: 0,
        footnotes: 1,
        bibliography: 1,
        library: 1,
      },
    });

    expect((await readAll('nodes')).map(n => n.book)).toEqual(['book_y']);
    expect(await readAll('hyperlights')).toEqual([]);
    expect(await readOne('library', 'book_x')).toBeUndefined();
    expect(await readOne('library', 'book_x/Fn1')).toBeUndefined();
    expect(await readOne('library', 'book_y')).toMatchObject({ title: 'Y' });
  });
});
