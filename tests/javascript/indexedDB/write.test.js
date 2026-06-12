/**
 * Pins nodes/write.js ahead of its TS conversion: standalone/shared-transaction
 * insert, node_id extraction from content, bulk save stamping, the exclusive
 * range delete, renumbering, and the raw bulk write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore, readAll, readOne } from './idbHarness.js';
import {
  addNodeChunkToIndexedDB,
  saveAllNodeChunksToIndexedDB,
  deleteNodeChunksAfter,
  renumberNodeChunksInIndexedDB,
  writeNodeChunks,
  initNodeWriteDependencies,
} from '../../../resources/js/indexedDB/nodes/write';

describe('nodes/write.js (characterization)', () => {
  let updateBookTimestamp;
  let queueForSync;

  beforeEach(() => {
    installFreshIndexedDB();
    document.body.innerHTML = '';
    updateBookTimestamp = vi.fn().mockResolvedValue(true);
    queueForSync = vi.fn();
    initNodeWriteDependencies({
      withPending: (fn) => fn(),
      book: 'bookA',
      updateBookTimestamp,
      queueForSync,
    });
  });

  it('addNodeChunkToIndexedDB extracts node_id from the content when not provided', async () => {
    const ok = await addNodeChunkToIndexedDB(
      'bookA', '100', '<p id="100" data-node-id="bookA-n100">hello</p>',
    );

    expect(ok).toBe(true);
    expect(await readOne('nodes', ['bookA', 100])).toEqual({
      book: 'bookA',
      startLine: 100,
      chunk_id: 0,
      node_id: 'bookA-n100',
      content: '<p id="100" data-node-id="bookA-n100">hello</p>',
      hyperlights: [],
      hypercites: [],
    });
  });

  it('addNodeChunkToIndexedDB prefers an explicit nodeId argument', async () => {
    await addNodeChunkToIndexedDB('bookA', 200, '<p data-node-id="ignored">x</p>', 5, 'explicit-id');
    expect(await readOne('nodes', ['bookA', 200])).toMatchObject({
      chunk_id: 5,
      node_id: 'explicit-id',
    });
  });

  it('saveAllNodeChunksToIndexedDB stamps book + numeric startLine and updates the timestamp', async () => {
    await saveAllNodeChunksToIndexedDB([
      { startLine: '100', chunk_id: 0, content: '<p>a</p>' },
      { startLine: '200.5', chunk_id: 1, content: '<p>b</p>' },
    ], 'bookB');

    const all = await readAll('nodes');
    expect(all.map(n => [n.book, n.startLine])).toEqual([['bookB', 100], ['bookB', 200.5]]);
    expect(updateBookTimestamp).toHaveBeenCalledWith('bookB');
    // Loading FROM the server must never queue a sync back to it
    expect(queueForSync).not.toHaveBeenCalled();
  });

  it('deleteNodeChunksAfter deletes strictly after the anchor, within the book', async () => {
    await seedStore('nodes', [
      { book: 'bookA', startLine: 100, chunk_id: 0, content: 'a' },
      { book: 'bookA', startLine: 200, chunk_id: 0, content: 'b' },
      { book: 'bookA', startLine: 300, chunk_id: 0, content: 'c' },
      { book: 'bookZ', startLine: 400, chunk_id: 0, content: 'z' },
    ]);

    await deleteNodeChunksAfter('bookA', 100);

    const remaining = await readAll('nodes');
    expect(remaining.map(n => [n.book, n.startLine])).toEqual([['bookA', 100], ['bookZ', 400]]);
  });

  it('renumberNodeChunksInIndexedDB deletes old keys and adds renumbered records', async () => {
    await seedStore('nodes', [
      { book: 'bookA', startLine: 100.5, chunk_id: 0, node_id: 'n-1', content: '<p>a</p>' },
    ]);

    await renumberNodeChunksInIndexedDB([
      { oldStartLine: 100.5, newStartLine: 200, chunk_id: 3, content: '<p>a</p>', node_id: 'n-1' },
    ], 'bookA');

    expect(await readOne('nodes', ['bookA', 100.5])).toBeUndefined();
    expect(await readOne('nodes', ['bookA', 200])).toEqual({
      book: 'bookA',
      startLine: 200,
      chunk_id: 3,
      content: '<p>a</p>',
      node_id: 'n-1',
      hyperlights: [],
      hypercites: [],
      footnotes: [],
    });
  });

  it('writeNodeChunks bulk-puts pre-formatted chunks via a raw connection', async () => {
    await seedStore('nodes', []); // ensure the DB exists for the raw versionless open
    await writeNodeChunks([
      { book: 'bookA', startLine: 100, chunk_id: 0, content: '<p>raw</p>' },
    ]);
    expect(await readOne('nodes', ['bookA', 100])).toMatchObject({ content: '<p>raw</p>' });
  });
});
