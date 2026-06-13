/**
 * Characterization of resources/js/hypercites/database.js — the IndexedDB +
 * Postgres write path for citations (fires in READ mode: copy-as-hypercite).
 *
 * Pins observable behavior BEFORE the .js → .ts migration:
 *   - getHyperciteById / getHyperciteData ... store reads
 *   - collectHyperciteData .................. DOM → block (char-offset walk)
 *   - NewHyperciteIndexedDB ................. the hypercites record shape +
 *                                             sync queue + flush (the new,
 *                                             normalized system; node-embed
 *                                             path is commented out in source)
 *   - fetchLibraryFromServer ................ bibtex passthrough / synth / null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne } from '../indexedDB/idbHarness.js';

// Real idb helpers via leaf modules; sync/rebuild deps stubbed & captured.
// vi.hoisted so these exist when the (hoisted) vi.mock factory runs.
const { queueForSync, updateBookTimestamp, rebuildNodeArrays, getNodesByDataNodeIDs, flush } = vi.hoisted(() => ({
  queueForSync: vi.fn(),
  updateBookTimestamp: vi.fn().mockResolvedValue(undefined),
  rebuildNodeArrays: vi.fn().mockResolvedValue(undefined),
  getNodesByDataNodeIDs: vi.fn().mockResolvedValue([]),
  flush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  const util = await import('../../../resources/js/indexedDB/core/utilities');
  return {
    openDatabase: conn.openDatabase,
    parseNodeId: util.parseNodeId,
    createNodeChunksKey: util.createNodeChunksKey,
    updateBookTimestamp,
    queueForSync,
    debouncedMasterSync: { flush },
    rebuildNodeArrays,
    getNodesByDataNodeIDs,
  };
});

import {
  getHyperciteById,
  getHyperciteData,
  collectHyperciteData,
  NewHyperciteIndexedDB,
  fetchLibraryFromServer,
} from '../../../resources/js/hypercites/database.js';
import { openDatabase } from '../../../resources/js/indexedDB/core/connection';

beforeEach(() => {
  installFreshIndexedDB();
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  document.head.innerHTML = '<meta name="csrf-token" content="tok">';
  document.body.innerHTML = '';
});

describe('getHyperciteById', () => {
  it('looks up via the hyperciteId index; undefined when absent', async () => {
    await seedStore('hypercites', [{ book: 'bookA', hyperciteId: 'hc1', hypercitedText: 'x' }]);
    const db = await openDatabase();
    expect(await getHyperciteById(db, 'hc1')).toMatchObject({ hyperciteId: 'hc1' });
    expect(await getHyperciteById(db, 'nope')).toBeUndefined();
  });
});

describe('getHyperciteData', () => {
  it('reads the nodes record by [book, startLine] key', async () => {
    await seedStore('nodes', [{ book: 'bookA', startLine: 3, chunk_id: 3, content: 'hi' }]);
    expect(await getHyperciteData('bookA', '3')).toMatchObject({ startLine: 3, content: 'hi' });
  });
});

describe('collectHyperciteData', () => {
  it('computes char offsets from the parent text-node walk and reads DOM context', () => {
    const host = document.createElement('div');
    host.setAttribute('data-book-id', 'bookA');
    host.innerHTML = '<div id="3" data-node-id="N3">Hello <u id="hc">world</u>!</div>';
    document.body.appendChild(host);

    const wrapper = host.querySelector('#hc');
    const blocks = collectHyperciteData('hc', wrapper);
    expect(blocks).toEqual([{
      startLine: '3',
      dataNodeId: 'N3',
      nodeBook: 'bookA',
      charStart: 6,           // "Hello " = 6 chars
      charEnd: 11,            // + "world" = 11
      elementType: 'div',
      hyperciteId: 'hc',
    }]);
  });

  it('returns [] when there is no numeric-id parent', () => {
    const host = document.createElement('div');
    host.innerHTML = '<section id="notnum"><u id="hc">x</u></section>';
    document.body.appendChild(host);
    expect(collectHyperciteData('hc', host.querySelector('#hc'))).toEqual([]);
  });
});

describe('NewHyperciteIndexedDB', () => {
  it('writes the normalized hypercite record and queues+flushes the PG sync', async () => {
    const u = document.createElement('u');
    u.id = 'hypercite_t';
    u.textContent = 'cited text';
    document.body.appendChild(u);

    const blocks = [{ startLine: '3', dataNodeId: 'N3', charStart: 6, charEnd: 11, hyperciteId: 'hypercite_t' }];
    await NewHyperciteIndexedDB('bookA', 'hypercite_t', blocks);

    const stored = await readOne('hypercites', ['bookA', 'hypercite_t']);
    expect(stored).toMatchObject({
      book: 'bookA',
      hyperciteId: 'hypercite_t',
      node_id: ['N3'],
      charData: { N3: { charStart: 6, charEnd: 11 } },
      hypercitedText: 'cited text',
      hypercitedHTML: 'cited text',   // <u> unwrapped
      relationshipStatus: 'single',
      citedIN: [],
      time_since: 1_700_000_000,
    });

    // syncs to Postgres: queue the hypercite, bump the book, flush immediately
    expect(updateBookTimestamp).toHaveBeenCalledWith('bookA');
    expect(queueForSync).toHaveBeenCalledWith('hypercites', 'hypercite_t', 'update', expect.objectContaining({ hyperciteId: 'hypercite_t' }));
    expect(flush).toHaveBeenCalled();
  });
});

describe('fetchLibraryFromServer', () => {
  function mockFetch(ok, body) {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });
  }

  it('returns the library as-is when it already has bibtex', async () => {
    mockFetch(true, { success: true, library: { bibtex: '@misc{x}', title: 'T' } });
    expect(await fetchLibraryFromServer('bookA')).toMatchObject({ bibtex: '@misc{x}' });
  });

  it('synthesizes a basic bibtex from title/author when none present', async () => {
    mockFetch(true, { success: true, library: { title: 'My Title', author: 'Ada' } });
    const lib = await fetchLibraryFromServer('bookA');
    expect(lib.bibtex).toContain('My Title');
    expect(lib.bibtex).toContain('Ada');
  });

  it('returns null when the library has neither bibtex nor title/author', async () => {
    mockFetch(true, { success: true, library: {} });
    expect(await fetchLibraryFromServer('bookA')).toBeNull();
  });

  it('returns null on a failed request', async () => {
    mockFetch(false, {});
    expect(await fetchLibraryFromServer('bookA')).toBeNull();
  });
});
