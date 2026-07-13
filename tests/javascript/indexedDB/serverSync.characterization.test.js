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
  loadNodesToIndexedDB,
  loadFootnotesToIndexedDB,
  clearBookDataFromIndexedDB,
} from '../../../resources/js/indexedDB/serverSync/index';
import { updateEmbeddedAnnotationsInNodes } from '../../../resources/js/indexedDB/serverSync/clear';

const BOOK = 'book_serversync_test';
const OTHER = 'book_other';

beforeEach(() => {
  installFreshIndexedDB();
});

describe('loadNodesToIndexedDB', () => {
  it('parses stringified annotation/footnote fields into arrays and writes the node', async () => {
    const db = await openDatabase();
    await loadNodesToIndexedDB(db, [
      {
        book: BOOK,
        startLine: '5',
        chunk_id: 0,
        node_id: 'n-5',
        content: '<p>hi</p>',
        hyperlights: '[{"hyperlight_id":"HL_1","is_user_highlight":true}]',
        footnotes: '["Fn1"]',
        hypercites: null,
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
    await loadNodesToIndexedDB(db, []);
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

describe('updateEmbeddedAnnotationsInNodes — embedded hyperlight shape', () => {
  // Regression guard for the unification: the embedded node-hyperlight uses the
  // canonical `highlightID` (NodeHyperlightView), NOT the store/PG key `hyperlight_id`.
  // This path (the annotations-only sync) was the one rogue builder that emitted
  // `hyperlight_id`; if it regresses, the renderer (which now reads only highlightID)
  // would silently drop the id. tsc guards the builder; this guards the runtime.
  it('embeds hyperlights keyed by highlightID, not hyperlight_id', async () => {
    await seedStore('nodes', [
      { book: BOOK, startLine: 100, chunk_id: 0, node_id: 'n1', content: '<p>x</p>', hyperlights: [], hypercites: [] },
    ]);
    const db = await openDatabase();

    await updateEmbeddedAnnotationsInNodes(
      db,
      BOOK,
      [{
        hyperlight_id: 'HL_1',            // standalone/PG key (snake_case) — the INPUT
        book: BOOK,
        node_id: ['n1'],
        charData: { n1: { charStart: 0, charEnd: 5 } },
        is_user_highlight: true,
        annotation: 'note',
        creator: null,
      }],
      [],
    );

    const node = await readOne('nodes', [BOOK, 100]);
    expect(node.hyperlights).toHaveLength(1);
    // Embedded view uses camelCase highlightID (mapped from the input's hyperlight_id)…
    expect(node.hyperlights[0]).toMatchObject({ highlightID: 'HL_1', charStart: 0, charEnd: 5 });
    // …and the rogue snake_case field is gone.
    expect(node.hyperlights[0]).not.toHaveProperty('hyperlight_id');
  });
});
