/**
 * Pins nodes/delete.js ahead of its TS conversion: numeric-id gate, node
 * deletion + sync queueing, and the orphan/cleanup bookkeeping on highlights
 * and hypercites that span the deleted node.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Dynamically imported in tx.oncomplete (only exists in edit mode) — stub it.
vi.mock('../../../resources/js/editToolbar/index.js', () => ({
  getEditToolbar: () => null,
}));

import { installFreshIndexedDB, seedStore, readOne, readAll } from './idbHarness.js';
import {
  deleteIndexedDBRecord,
  initNodeDeleteDependencies,
} from '../../../resources/js/indexedDB/nodes/delete';

describe('deleteIndexedDBRecord', () => {
  let updateBookTimestamp;
  let queueForSync;

  beforeEach(() => {
    installFreshIndexedDB();
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';
    updateBookTimestamp = vi.fn().mockResolvedValue(true);
    queueForSync = vi.fn();
    initNodeDeleteDependencies({
      withPending: (fn) => fn(),
      book: 'bookA',
      updateBookTimestamp,
      queueForSync,
    });
  });

  it('refuses non-numeric ids without touching the DB', async () => {
    await seedStore('nodes', [{ book: 'bookA', startLine: 100, chunk_id: 0, content: 'x' }]);
    const ok = await deleteIndexedDBRecord('not-a-number');
    expect(ok).toBe(false);
    expect(await readAll('nodes')).toHaveLength(1);
  });

  it('deletes the node and queues a nodes delete with the full record', async () => {
    const record = { book: 'bookA', startLine: 500, chunk_id: 0, node_id: 'n-500', content: '<p>bye</p>' };
    await seedStore('nodes', [record]);

    const ok = await deleteIndexedDBRecord('500');

    expect(ok).toBe(true);
    expect(await readOne('nodes', ['bookA', 500])).toBeUndefined();
    expect(updateBookTimestamp).toHaveBeenCalledWith('bookA');
    expect(queueForSync).toHaveBeenCalledWith('nodes', 500, 'delete', expect.objectContaining({ node_id: 'n-500' }));
  });

  it('marks a MULTI-node highlight with _deleted_nodes but keeps it alive', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <p id="500" data-node-id="n-500">doomed</p>
      </div>`;
    await seedStore('nodes', [{ book: 'bookA', startLine: 500, chunk_id: 0, node_id: 'n-500', content: 'x' }]);
    await seedStore('hyperlights', [{
      book: 'bookA', hyperlight_id: 'HL_multi',
      node_id: ['n-500', 'n-600'],
      charData: { 'n-500': { charStart: 0, charEnd: 3 }, 'n-600': { charStart: 0, charEnd: 5 } },
    }]);

    await deleteIndexedDBRecord('500');

    const hl = await readOne('hyperlights', ['bookA', 'HL_multi']);
    expect(hl._deleted_nodes).toEqual(['n-500']);
    expect(hl._orphaned_at).toBeUndefined();
    // node_id and charData are intentionally kept until the next save's cleanup
    expect(hl.node_id).toEqual(['n-500', 'n-600']);
  });

  it('marks a SINGLE-node highlight and hypercite as orphaned (recoverable)', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="bookA">
        <p id="500" data-node-id="n-500">doomed</p>
      </div>`;
    await seedStore('nodes', [{ book: 'bookA', startLine: 500, chunk_id: 0, node_id: 'n-500', content: 'x' }]);
    await seedStore('hyperlights', [{
      book: 'bookA', hyperlight_id: 'HL_single',
      node_id: ['n-500'], charData: { 'n-500': { charStart: 0, charEnd: 3 } },
    }]);
    await seedStore('hypercites', [{
      book: 'bookA', hyperciteId: 'hypercite_single',
      node_id: ['n-500'], charData: { 'n-500': { charStart: 0, charEnd: 3 } },
    }]);

    await deleteIndexedDBRecord('500');

    const hl = await readOne('hyperlights', ['bookA', 'HL_single']);
    expect(hl._orphaned_at).toEqual(expect.any(Number));
    expect(hl._orphaned_from_node).toBe('n-500');
    expect(hl._deleted_nodes).toEqual(['n-500']);

    const hc = await readOne('hypercites', ['bookA', 'hypercite_single']);
    expect(hc._orphaned_at).toEqual(expect.any(Number));
    expect(hc._deleted_nodes).toEqual(['n-500']);
  });
});
