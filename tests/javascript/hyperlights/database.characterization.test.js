/**
 * Characterization of resources/js/hyperlights/database.js — the IndexedDB
 * write path for highlights (fires even in READ mode: select text → highlight).
 *
 * Pins observable behavior BEFORE the .js → .ts migration:
 *   - addToHighlightsTable .............. the hyperlights record shape + auth
 *   - removeHighlightFromNodeChunks ..... cursor removal, only-changed return
 *   - …WithDeletion ..................... the _deleted tombstone sync copy
 *   - removeHighlightFromHyperlights .... index lookup + delete, null-on-miss
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne, readAll } from '../indexedDB/idbHarness.js';

// Use the REAL idb helpers (via leaf modules) without loading the whole barrel.
vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  const util = await import('../../../resources/js/indexedDB/core/utilities');
  return { openDatabase: conn.openDatabase, parseNodeId: util.parseNodeId, createNodeChunksKey: util.createNodeChunksKey };
});

// Auth context is swapped per test.
let authValue;
vi.mock('../../../resources/js/utilities/auth', () => ({
  getAuthContextSync: () => authValue,
  getAuthContext: async () => authValue,
}));

import {
  addToHighlightsTable,
  removeHighlightFromNodeChunks,
  removeHighlightFromNodeChunksWithDeletion,
  removeHighlightFromHyperlights,
} from '../../../resources/js/hyperlights/database.js';

/** Fake selection whose cloneContents yields "Hello <mark>world</mark>". */
function selectionWithMark() {
  return {
    getRangeAt: () => ({
      cloneContents: () => {
        const frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode('Hello '));
        const m = document.createElement('mark');
        m.textContent = 'world';
        frag.appendChild(m);
        return frag;
      },
    }),
  };
}

beforeEach(() => {
  installFreshIndexedDB();
  authValue = { user: { name: 'Ada' }, userId: 'u1' };
  vi.spyOn(window, 'getSelection').mockReturnValue(selectionWithMark());
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
});

describe('addToHighlightsTable', () => {
  const highlightData = () => ({
    highlightId: 'HL_a',
    charData: { n1: { charStart: 0, charEnd: 5 }, n2: { charStart: 0, charEnd: 4 } },
    text: 'Hello world',
    startLine: 3,
  });

  it('builds the hyperlights record: marks stripped from HTML, node_id = Object.keys(charData)', async () => {
    const entry = await addToHighlightsTable('bookA', highlightData());
    expect(entry).toMatchObject({
      book: 'bookA',
      hyperlight_id: 'HL_a',
      node_id: ['n1', 'n2'],
      highlightedText: 'Hello world',
      highlightedHTML: 'Hello world', // <mark> unwrapped to its text
      annotation: '',
      startLine: 3,
      is_user_highlight: true,
      time_since: 1_700_000_000,
    });
    expect(entry.charData).toEqual(highlightData().charData);
    // persisted under the composite key [book, hyperlight_id]
    expect(await readOne('hyperlights', ['bookA', 'HL_a'])).toMatchObject({ hyperlight_id: 'HL_a' });
  });

  it('logged-in user → creator=name, creator_token=null', async () => {
    authValue = { user: { name: 'Ada' }, userId: 'u1' };
    const entry = await addToHighlightsTable('bookA', highlightData());
    expect(entry.creator).toBe('Ada');
    expect(entry.creator_token).toBeNull();
  });

  it('anonymous user → creator=null, creator_token=userId', async () => {
    authValue = { user: null, userId: 'anon-token' };
    const entry = await addToHighlightsTable('bookA', highlightData());
    expect(entry.creator).toBeNull();
    expect(entry.creator_token).toBe('anon-token');
  });
});

describe('removeHighlightFromNodeChunks', () => {
  beforeEach(async () => {
    await seedStore('nodes', [
      { book: 'bookA', startLine: 1, chunk_id: 1, content: '', hyperlights: [{ highlightID: 'HL_x' }, { highlightID: 'HL_y' }] },
      { book: 'bookA', startLine: 2, chunk_id: 2, content: '', hyperlights: [{ highlightID: 'HL_z' }] },
      { book: 'bookB', startLine: 3, chunk_id: 3, content: '', hyperlights: [{ highlightID: 'HL_x' }] },
    ]);
  });

  it('removes the highlight only from this book and returns only the changed nodes', async () => {
    const changed = await removeHighlightFromNodeChunks('bookA', 'HL_x');
    expect(changed).toHaveLength(1);
    expect(changed[0].startLine).toBe(1);
    expect(changed[0].hyperlights).toEqual([{ highlightID: 'HL_y' }]);

    expect((await readOne('nodes', ['bookA', 1])).hyperlights).toEqual([{ highlightID: 'HL_y' }]);
    expect((await readOne('nodes', ['bookA', 2])).hyperlights).toEqual([{ highlightID: 'HL_z' }]); // untouched
    expect((await readOne('nodes', ['bookB', 3])).hyperlights).toEqual([{ highlightID: 'HL_x' }]); // other book untouched
  });
});

describe('removeHighlightFromNodeChunksWithDeletion', () => {
  it('stores the node without the highlight, but returns a sync copy with a _deleted tombstone', async () => {
    await seedStore('nodes', [
      { book: 'bookA', startLine: 1, chunk_id: 1, content: '', hyperlights: [{ highlightID: 'HL_x' }, { highlightID: 'HL_y' }] },
    ]);

    const syncCopies = await removeHighlightFromNodeChunksWithDeletion('bookA', 'HL_x', {});
    expect(syncCopies).toHaveLength(1);
    expect(syncCopies[0].hyperlights).toEqual([
      { highlightID: 'HL_y' },
      { highlightID: 'HL_x', _deleted: true },
    ]);

    // the PERSISTED node has only the survivor, no tombstone
    expect((await readOne('nodes', ['bookA', 1])).hyperlights).toEqual([{ highlightID: 'HL_y' }]);
  });
});

describe('removeHighlightFromHyperlights', () => {
  it('deletes via the hyperlight_id index and returns the deleted record', async () => {
    await seedStore('hyperlights', [{ book: 'bookA', hyperlight_id: 'HL_x', annotation: 'note' }]);

    const deleted = await removeHighlightFromHyperlights('HL_x');
    expect(deleted).toMatchObject({ hyperlight_id: 'HL_x', annotation: 'note' });
    expect(await readAll('hyperlights')).toEqual([]);
  });

  it('returns null when the highlight does not exist', async () => {
    expect(await removeHighlightFromHyperlights('HL_missing')).toBeNull();
  });
});
