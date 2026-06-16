/**
 * Characterization tests for the server→IndexedDB hydrate layer
 * (currently resources/js/postgreSQL.js, migrating to indexedDB/serverSync/).
 *
 * Pins the deterministic IDB-writer / clear behaviour so the JS→TS move +
 * decomposition into serverSync/ is provably behaviour-preserving. Network /
 * fetch paths (syncBookDataFromDatabase, syncAnnotationsOnly) are not exercised
 * here — only the pure store-writer helpers they delegate to.
 *
 * NOTE: the import path below is repointed from ../../../resources/js/postgreSQL.js
 * to ../../../resources/js/indexedDB/serverSync as part of the migration — the
 * assertions stay identical, which is the whole point of a characterization gate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, readAll, readOne, seedStore } from './idbHarness.js';
import { openDatabase } from '../../../resources/js/indexedDB/core/connection';
import {
  loadNodeChunksToIndexedDB,
  loadFootnotesToIndexedDB,
  clearBookDataFromIndexedDB,
} from '../../../resources/js/indexedDB/serverSync/index';

const BOOK = 'book_serversync_test';
const OTHER = 'book_other';

beforeEach(() => {
  installFreshIndexedDB();
});

describe('loadNodeChunksToIndexedDB', () => {
  it('parses stringified annotation/footnote fields into arrays and writes the node', async () => {
    const db = await openDatabase();
    await loadNodeChunksToIndexedDB(db, [
      {
        book: BOOK,
        startLine: '5',
        chunk_id: 0,
        node_id: 'n-5',
        content: '<p>hi</p>',
        hyperlights: '[{"hyperlight_id":"HL_1","is_user_highlight":true}]',
        footnotes: '["Fn1"]',
        hypercites: null,
        raw_json: null,
      },
    ]);

    const rows = await readAll('nodes');
    expect(rows).toHaveLength(1);
    expect(rows[0].book).toBe(BOOK);
    expect(Array.isArray(rows[0].hyperlights)).toBe(true);
    expect(rows[0].hyperlights[0].hyperlight_id).toBe('HL_1');
    expect(rows[0].footnotes).toEqual(['Fn1']);
  });

  it('is a no-op for empty input', async () => {
    const db = await openDatabase();
    await loadNodeChunksToIndexedDB(db, []);
    expect(await readAll('nodes')).toHaveLength(0);
  });
});

describe('loadFootnotesToIndexedDB', () => {
  it('expands the footnotes.data object into per-footnote records', async () => {
    const db = await openDatabase();
    await loadFootnotesToIndexedDB(db, {
      book: BOOK,
      data: { Fn1: { content: '<p>note</p>', preview_nodes: null } },
    });

    const rec = await readOne('footnotes', [BOOK, 'Fn1']);
    expect(rec).toMatchObject({ book: BOOK, footnoteId: 'Fn1', content: '<p>note</p>' });
  });
});

describe('clearBookDataFromIndexedDB', () => {
  it('removes only the target book rows across the book-indexed stores', async () => {
    await seedStore('nodes', [
      { book: BOOK, startLine: 1, chunk_id: 0, node_id: 'a' },
      { book: OTHER, startLine: 1, chunk_id: 0, node_id: 'b' },
    ]);
    await seedStore('library', [{ book: BOOK }, { book: OTHER }]);

    const db = await openDatabase();
    await clearBookDataFromIndexedDB(db, BOOK);

    const nodes = await readAll('nodes');
    expect(nodes.map((n) => n.book)).toEqual([OTHER]);
    expect(await readOne('library', BOOK)).toBeUndefined();
    expect(await readOne('library', OTHER)).toMatchObject({ book: OTHER });
  });
});
