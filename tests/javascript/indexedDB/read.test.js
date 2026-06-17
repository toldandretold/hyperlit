/**
 * Pins nodes/read.js ahead of its TS conversion: sort orders, single-key get,
 * and the exclusive-lower-bound range query. Note: getNodeChunkFromIndexedDB
 * and getNodeChunksAfter open their own raw connection (indexedDB.open without
 * a version) instead of the shared singleton — pinned here by just working.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore } from './idbHarness.js';
import {
  getNodeChunksFromIndexedDB,
  getAllNodeChunksForBook,
  getNodeChunkFromIndexedDB,
  getNodeChunksAfter,
} from '../../../resources/js/indexedDB/nodes/read';

function node(book, startLine, chunk_id) {
  return { book, startLine, chunk_id, node_id: `${book}-${startLine}`, content: `<p>${startLine}</p>` };
}

describe('nodes/read.js (characterization)', () => {
  beforeEach(async () => {
    installFreshIndexedDB();
    await seedStore('nodes', [
      node('bookA', 300, 1),
      node('bookA', 100, 2),
      node('bookA', 200, 0),
      node('bookB', 150, 0),
    ]);
  });

  it('getNodeChunksFromIndexedDB returns the book sorted by chunk_id', async () => {
    const chunks = await getNodeChunksFromIndexedDB('bookA');
    expect(chunks.map(c => c.chunk_id)).toEqual([0, 1, 2]);
    expect(chunks.every(c => c.book === 'bookA')).toBe(true);
  });

  it('getAllNodeChunksForBook returns the book sorted by startLine', async () => {
    const chunks = await getAllNodeChunksForBook('bookA');
    expect(chunks.map(c => c.startLine)).toEqual([100, 200, 300]);
  });

  it('getNodeChunkFromIndexedDB fetches one record by [book, numeric startLine]', async () => {
    const record = await getNodeChunkFromIndexedDB('bookA', '200');
    expect(record).toMatchObject({ book: 'bookA', startLine: 200, chunk_id: 0 });
    // Missing key resolves to undefined (IDB get semantics), not null
    expect(await getNodeChunkFromIndexedDB('bookA', '999')).toBeUndefined();
  });

  it('getNodeChunksAfter excludes the anchor node and stays within the book', async () => {
    const after = await getNodeChunksAfter('bookA', 100);
    expect(after.map(c => c.startLine)).toEqual([200, 300]);
    // bookB's 150 must not leak into bookA's range
    expect(after.every(c => c.book === 'bookA')).toBe(true);
  });

  // The head/tail split that paste relies on MUST be decimal-safe — a node inserted
  // between 100 and 200 gets a fractional startLine (150.5), and truncating the anchor
  // (parseInt) would corrupt the split and therefore paste insertion order. This pins
  // that getNodeChunksAfter compares on the real (parseFloat) value.
  it('getNodeChunksAfter is decimal-safe: fractional anchor + fractional tail nodes', async () => {
    await seedStore('nodes', [node('bookA', 150.5, 0)]); // bookA now: 100, 150.5, 200, 300

    // Anchor AT the decimal node: it is excluded, and is NOT truncated to 150
    // (which would wrongly re-include 150.5 in its own tail).
    const afterDecimal = await getNodeChunksAfter('bookA', '150.5');
    expect(afterDecimal.map(c => c.startLine)).toEqual([200, 300]);

    // Anchor at the integer below: the fractional 150.5 must survive in the tail,
    // in correct order (a truncating compare could drop or misplace it).
    const after150 = await getNodeChunksAfter('bookA', 150);
    expect(after150.map(c => c.startLine)).toEqual([150.5, 200, 300]);
  });
});
