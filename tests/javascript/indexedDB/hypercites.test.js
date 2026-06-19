/**
 * Pins the hypercites domain (index.js, helpers.js, syncHypercitesToPostgreSQL.js)
 * ahead of TS conversion: raw-connection get/update, the citedIN/relationshipStatus
 * state machine (single → couple → poly), the resolve-or-fetch-and-cache helper,
 * and the hypercitedHTML regeneration on sync.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne, readAll } from './idbHarness.js';
import {
  getHyperciteFromIndexedDB,
  updateHyperciteInIndexedDB,
  addCitationToHypercite,
  updateCitationForExistingHypercite,
  initHypercitesDependencies,
} from '../../../resources/js/indexedDB/hypercites/index';
import { resolveHypercite } from '../../../resources/js/indexedDB/hypercites/helpers';
import {
  syncHyperciteToPostgreSQL,
  syncHyperciteWithNodeImmediately,
} from '../../../resources/js/indexedDB/hypercites/syncHypercitesToPostgreSQL';
import { getNodesFromIndexedDB } from '../../../resources/js/indexedDB/nodes/read';

function hc(book, hyperciteId, extra = {}) {
  return {
    book, hyperciteId,
    hypercitedText: 'cited text',
    citedIN: [], relationshipStatus: 'single',
    node_id: [], charData: {}, time_since: 1, ...extra,
  };
}

describe('hypercites domain (characterization)', () => {
  let updateBookTimestamp;
  let queueForSync;
  let fetchMock;

  beforeEach(() => {
    installFreshIndexedDB();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
    updateBookTimestamp = vi.fn().mockResolvedValue(true);
    queueForSync = vi.fn();
    initHypercitesDependencies({
      updateBookTimestamp,
      queueForSync,
      withPending: (fn) => fn(),
      getNodesFromIndexedDB,
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('getHyperciteFromIndexedDB fetches by [book, hyperciteId]; missing → undefined', async () => {
    await seedStore('hypercites', [hc('bookA', 'hypercite_1')]);
    expect(await getHyperciteFromIndexedDB('bookA', 'hypercite_1')).toMatchObject({ hyperciteId: 'hypercite_1' });
    expect(await getHyperciteFromIndexedDB('bookA', 'hypercite_missing')).toBeUndefined();
  });

  it('updateHyperciteInIndexedDB merges fields, stamps the book, queues unless skipQueue', async () => {
    await seedStore('hypercites', [hc('bookA', 'hypercite_1')]);

    const ok = await updateHyperciteInIndexedDB('bookA', 'hypercite_1', { relationshipStatus: 'couple', citedIN: ['x'] });

    expect(ok).toBe(true);
    expect(await readOne('hypercites', ['bookA', 'hypercite_1'])).toMatchObject({
      relationshipStatus: 'couple',
      citedIN: ['x'],
      hypercitedText: 'cited text', // untouched fields survive
    });
    expect(updateBookTimestamp).toHaveBeenCalledWith('bookA');
    expect(queueForSync).toHaveBeenCalledWith('hypercites', 'hypercite_1', 'update', expect.anything());

    queueForSync.mockClear();
    await updateHyperciteInIndexedDB('bookA', 'hypercite_1', { citedIN: ['x', 'y'] }, true);
    expect(queueForSync).not.toHaveBeenCalled();

    // Missing record → false, no throw
    expect(await updateHyperciteInIndexedDB('bookA', 'nope', {})).toBe(false);
  });

  it('addCitationToHypercite updates the EMBEDDED array on the node: dedupe + single→couple→poly', async () => {
    await seedStore('nodes', [{
      book: 'bookA', startLine: 100, chunk_id: 0, node_id: 'n-100', content: '<p>x</p>',
      hypercites: [{ hyperciteId: 'hypercite_1', citedIN: [], relationshipStatus: 'single' }],
    }]);

    let result = await addCitationToHypercite('bookA', '100', 'hypercite_1', 'citing-book/hc1');
    expect(result).toEqual({ success: true, relationshipStatus: 'couple' });

    // Duplicate is ignored, status unchanged
    result = await addCitationToHypercite('bookA', '100', 'hypercite_1', 'citing-book/hc1');
    expect(result.relationshipStatus).toBe('couple');

    result = await addCitationToHypercite('bookA', '100', 'hypercite_1', 'other-book/hc2');
    expect(result.relationshipStatus).toBe('poly');

    const node = await readOne('nodes', ['bookA', 100]);
    expect(node.hypercites[0].citedIN).toEqual(['citing-book/hc1', 'other-book/hc2']);

    // Missing node → {success: false}
    expect(await addCitationToHypercite('bookA', '999', 'hypercite_1', 'z')).toEqual({ success: false });
  });

  it('resolveHypercite: local hit needs cached nodes; otherwise fetches AND caches hypercite + whole book', async () => {
    // Local hypercite + cached nodes → no fetch
    await seedStore('hypercites', [hc('bookA', 'hypercite_local')]);
    await seedStore('nodes', [{ book: 'bookA', startLine: 100, chunk_id: 0, content: 'x' }]);
    expect(await resolveHypercite('bookA', 'hypercite_local')).toMatchObject({ hyperciteId: 'hypercite_local' });
    expect(fetchMock).not.toHaveBeenCalled();

    // Unknown hypercite → server fetch, then both stores get cached
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        hypercite: hc('bookB', 'hypercite_remote'),
        nodes: [
          { book: 'bookB', startLine: 100, chunk_id: 0, content: '<p>b1</p>' },
          { book: 'bookB', startLine: 200, chunk_id: 0, content: '<p>b2</p>' },
        ],
      }),
    });

    const resolved = await resolveHypercite('bookB', 'hypercite_remote');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/db/hypercites/find/bookB/hypercite_remote');
    expect(resolved).toMatchObject({ hyperciteId: 'hypercite_remote' });
    expect(await readOne('hypercites', ['bookB', 'hypercite_remote'])).toBeTruthy();
    expect((await readAll('nodes')).filter(n => n.book === 'bookB')).toHaveLength(2);
  });

  it('updateCitationForExistingHypercite runs the full arc: resolve → update → rebuild → report', async () => {
    await seedStore('hypercites', [hc('bookA', 'hypercite_1', {
      node_id: ['n-100'],
      charData: { 'n-100': { charStart: 0, charEnd: 5 } },
    })]);
    await seedStore('nodes', [{
      book: 'bookA', startLine: 100, chunk_id: 0, node_id: 'n-100',
      content: '<p>x</p>', hyperlights: [], hypercites: [], footnotes: [],
    }]);

    const result = await updateCitationForExistingHypercite('bookA', 'hypercite_1', 'citing-book/hcX');

    expect(result).toEqual({ success: true, startLine: 100, newStatus: 'couple' });
    const stored = await readOne('hypercites', ['bookA', 'hypercite_1']);
    expect(stored.citedIN).toEqual(['citing-book/hcX']);
    expect(stored.relationshipStatus).toBe('couple');
    expect(queueForSync).toHaveBeenCalledWith('hypercites', 'hypercite_1', 'update', expect.anything());
  });

  it('syncHyperciteToPostgreSQL REGENERATES hypercitedHTML from id+status+text', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });

    await syncHyperciteToPostgreSQL([hc('bookA', 'hypercite_1', {
      relationshipStatus: 'couple',
      hypercitedHTML: '<u id="hypercite_1" class="single">stale html</u>',
    })]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/db/hypercites/upsert');
    expect(body.data[0].hypercitedHTML).toBe('<u id="hypercite_1" class="couple">cited text</u>');
  });

  it('syncHyperciteWithNodeImmediately POSTs the atomic unified payload (NO footnote/bibliography fields)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    const chunk = { book: 'bookA', startLine: 100, chunk_id: 0, content: '<p>x</p>' };

    await syncHyperciteWithNodeImmediately('bookA', hc('bookA', 'hypercite_1'), chunk);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/db/unified-sync');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Pinned: this immediate payload is NARROWER than master.js's — no
    // footnotes/footnoteDeletions/bibliography/bibliographyDeletions keys.
    expect(Object.keys(body).sort()).toEqual(
      ['book', 'hypercites', 'hyperlightDeletions', 'hyperlights', 'library', 'nodes'],
    );
    expect(body.nodes).toEqual([chunk]);
    expect(body.hypercites[0].hyperciteId).toBe('hypercite_1');
  });
});
