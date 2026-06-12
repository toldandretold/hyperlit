// @vitest-environment jsdom
/**
 * Characterization of batchDeleteIndexedDBRecords (batch.js) ahead of the
 * decompose-and-convert: dedup, invalid-id skip, sub-book routing, sync
 * queueing of full records, and the DUAL-SCHEMA annotation fork —
 * OLD startLine-keyed single highlights are DELETED (recorded for undo),
 * NEW node_id-keyed singles are ORPHANED, multi-node ones get _deleted_nodes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/postgreSQL.js', () => ({
  syncIndexedDBtoPostgreSQL: vi.fn(),
}));
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));
vi.mock('../../../resources/js/integrity/reporter.js', () => ({
  reportIntegrityFailure: vi.fn(),
  reportServerError: vi.fn(),
}));
vi.mock('../../../resources/js/footnotes/FootnoteNumberingService.js', () => ({
  rebuildAndRenumber: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/auth.js', () => ({
  refreshCsrfToken: vi.fn(),
  getCurrentUserId: vi.fn(() => null),
}));

import { installFreshIndexedDB, seedStore, readOne, readAll, waitFor } from './idbHarness.js';
import {
  batchDeleteIndexedDBRecords,
  initNodeBatchDependencies,
} from '../../../resources/js/indexedDB/nodes/batch';
import {
  pendingSyncs,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';

function node(book, startLine, nodeId) {
  return {
    book, startLine, chunk_id: 0, node_id: nodeId,
    content: `<p>${startLine}</p>`, hyperlights: [], hypercites: [], footnotes: [],
  };
}

describe('batchDeleteIndexedDBRecords (characterization)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';
    pendingSyncs.clear();
    initSyncQueueDependencies({ debouncedMasterSync: vi.fn() });
    initNodeBatchDependencies({ book: 'bookA' });
  });

  it('deletes unique numeric ids, skips invalid ones, queues full records for sync', async () => {
    await seedStore('nodes', [node('bookA', 100, 'n-100'), node('bookA', 200, 'n-200')]);

    await batchDeleteIndexedDBRecords(['100', '100', 'garbage', '200']);

    expect(await readAll('nodes')).toEqual([]);
    const queued100 = pendingSyncs.get('nodes-bookA-100');
    expect(queued100.type).toBe('delete');
    expect(queued100.data).toMatchObject({ node_id: 'n-100', content: '<p>100</p>' });
    expect(pendingSyncs.has('nodes-bookA-200')).toBe(true);
    expect(pendingSyncs.has('library-bookA-bookA')).toBe(true); // timestamp side-effect
  });

  it('routes to an explicit bookId without consulting the DOM', async () => {
    await seedStore('nodes', [
      node('book_bookA/Fn1', 100, 'sub-100'),
      node('bookA', 100, 'n-100'), // same startLine in parent — must survive
    ]);

    await batchDeleteIndexedDBRecords(['100'], new Map(), 'book_bookA/Fn1');

    expect(await readOne('nodes', ['book_bookA/Fn1', 100])).toBeUndefined();
    expect(await readOne('nodes', ['bookA', 100])).toBeTruthy();
  });

  it('OLD-schema single highlight (startLine-keyed) is DELETED and queued for undo', async () => {
    await seedStore('nodes', [node('bookA', 100, 'n-100')]);
    await seedStore('hyperlights', [{
      book: 'bookA', hyperlight_id: 'HL_old', startLine: 100,
      // no node_id array — pure OLD schema
    }]);

    await batchDeleteIndexedDBRecords(['100']);

    expect(await readOne('hyperlights', ['bookA', 'HL_old'])).toBeUndefined();
    const queued = pendingSyncs.get('hyperlights-bookA-HL_old');
    expect(queued.type).toBe('delete');
  });

  it('NEW-schema annotations: multi-node gets _deleted_nodes, single-node gets orphaned; survivors rebuilt', async () => {
    await seedStore('nodes', [
      node('bookA', 100, 'n-100'),      // will be deleted
      node('bookA', 200, 'n-200'),      // survivor sharing the multi-node highlight
    ]);
    await seedStore('hyperlights', [
      {
        book: 'bookA', hyperlight_id: 'HL_multi', startLine: 999,
        node_id: ['n-100', 'n-200'],
        charData: { 'n-100': { charStart: 0, charEnd: 3 }, 'n-200': { charStart: 0, charEnd: 5 } },
      },
      {
        book: 'bookA', hyperlight_id: 'HL_single_new', startLine: 999,
        node_id: ['n-100'],
        charData: { 'n-100': { charStart: 1, charEnd: 2 } },
      },
    ]);
    await seedStore('hypercites', [{
      book: 'bookA', hyperciteId: 'hypercite_multi', startLine: 999,
      node_id: ['n-100', 'n-200'],
      charData: { 'n-100': { charStart: 0, charEnd: 3 }, 'n-200': { charStart: 2, charEnd: 4 } },
      relationshipStatus: 'single', citedIN: [],
    }]);

    const deletionMap = new Map([['100', 'n-100']]);
    await batchDeleteIndexedDBRecords(['100'], deletionMap);

    // Multi-node highlight: alive, tagged for later cleanup, membership intact
    const multi = await readOne('hyperlights', ['bookA', 'HL_multi']);
    expect(multi._deleted_nodes).toEqual(['n-100']);
    expect(multi._orphaned_at).toBeUndefined();
    expect(multi.node_id).toEqual(['n-100', 'n-200']);

    // NEW-schema single: orphaned (recoverable), not deleted
    const single = await readOne('hyperlights', ['bookA', 'HL_single_new']);
    expect(single._orphaned_at).toEqual(expect.any(Number));
    expect(single._orphaned_from_node).toBe('n-100');

    // Multi-node hypercite: same _deleted_nodes treatment
    const cite = await readOne('hypercites', ['bookA', 'hypercite_multi']);
    expect(cite._deleted_nodes).toEqual(['n-100']);

    // The SURVIVOR node's cached arrays get rebuilt (fire-and-forget — poll)
    await waitFor(async () => {
      const survivor = await readOne('nodes', ['bookA', 200]);
      return survivor.hyperlights.length === 1 && survivor.hypercites.length === 1;
    });
    const survivor = await readOne('nodes', ['bookA', 200]);
    expect(survivor.hyperlights[0]).toMatchObject({ highlightID: 'HL_multi', charStart: 0, charEnd: 5 });
    expect(survivor.hypercites[0]).toMatchObject({ hyperciteId: 'hypercite_multi', charStart: 2, charEnd: 4 });
  });
});
