/**
 * Pins nodes/normalize.js ahead of its TS conversion: the get → put-new →
 * delete-old key migration, field preservation, sub-book routing, and the
 * sync queueing on completion (update new id + delete old id).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne } from './idbHarness.js';
import {
  updateIndexedDBRecordForNormalization,
  initNodeNormalizeDependencies,
} from '../../../resources/js/indexedDB/nodes/normalize';

describe('updateIndexedDBRecordForNormalization', () => {
  let updateBookTimestamp;
  let queueForSync;

  beforeEach(() => {
    installFreshIndexedDB();
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';
    updateBookTimestamp = vi.fn().mockResolvedValue(true);
    queueForSync = vi.fn();
    initNodeNormalizeDependencies({
      withPending: (fn) => fn(),
      book: 'bookA',
      updateBookTimestamp,
      queueForSync,
    });
  });

  it('moves a record to its new key, preserving fields and replacing content', async () => {
    await seedStore('nodes', [{
      book: 'bookA', startLine: 150.5, chunk_id: 2, node_id: 'n-150',
      content: '<p>old</p>', hyperlights: [], hypercites: [], footnotes: [],
    }]);

    const ok = await updateIndexedDBRecordForNormalization('150.5', '200', '<p>new</p>');

    expect(ok).toBe(true);
    expect(await readOne('nodes', ['bookA', 150.5])).toBeUndefined();
    const moved = await readOne('nodes', ['bookA', 200]);
    expect(moved).toMatchObject({
      book: 'bookA',
      startLine: 200,
      chunk_id: 2,          // preserved from the old record
      node_id: 'n-150',     // preserved
      content: '<p>new</p>', // replaced by the html argument
    });

    expect(updateBookTimestamp).toHaveBeenCalledWith('bookA');
    // Queues the new id as an update (with the fresh record) and the old id as a delete
    expect(queueForSync).toHaveBeenCalledWith('nodes', '200', 'update', expect.objectContaining({ startLine: 200 }));
    expect(queueForSync).toHaveBeenCalledWith('nodes', '150.5', 'delete');
  });

  it('keeps the old content when no html is given', async () => {
    await seedStore('nodes', [{
      book: 'bookA', startLine: 100, chunk_id: 0, node_id: 'n-100',
      content: '<p>keep me</p>', hyperlights: [], hypercites: [], footnotes: [],
    }]);

    await updateIndexedDBRecordForNormalization('100', '110', null);

    const moved = await readOne('nodes', ['bookA', 110]);
    expect(moved.content).toBe('<p>keep me</p>');
  });

  it('creates a fresh minimal record when the old key does not exist', async () => {
    await updateIndexedDBRecordForNormalization('300', '310', '<p>fresh</p>');

    const created = await readOne('nodes', ['bookA', 310]);
    expect(created).toEqual({
      book: 'bookA',
      startLine: 310,
      chunk_id: 0,
      content: '<p>fresh</p>',
      hyperlights: [],
      hypercites: [],
    });
  });

  it('routes to the sub-book when the element lives in a [data-book-id] container', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <div data-book-id="book_bookA/Fn3"><p id="400">x</p></div>
      </div>`;
    await seedStore('nodes', [{
      book: 'book_bookA/Fn3', startLine: 400, chunk_id: 0, node_id: 'sub-400',
      content: '<p>sub</p>', hyperlights: [], hypercites: [], footnotes: [],
    }]);

    await updateIndexedDBRecordForNormalization('400', '410', null);

    expect(await readOne('nodes', ['book_bookA/Fn3', 410])).toMatchObject({ content: '<p>sub</p>' });
    expect(await readOne('nodes', ['bookA', 410])).toBeUndefined();
    expect(updateBookTimestamp).toHaveBeenCalledWith('book_bookA/Fn3');
  });
});
