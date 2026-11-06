/**
 * Suggested-edit data layer (resources/js/hyperlights/suggestedEdit.ts):
 * per-node segment slicing (offsets include footnote sup digits), the
 * {before, after} save semantics (drop-identical, snapshot preserved on
 * re-edit, empty map ⇒ withdraw), and the server-authoritative resolve mirror.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readAll } from '../indexedDB/idbHarness.js';

const queueForSync = vi.fn();
const updateAnnotationsTimestamp = vi.fn();

vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  return {
    openDatabase: conn.openDatabase,
    queueForSync: (...args) => queueForSync(...args),
    updateAnnotationsTimestamp: (...args) => updateAnnotationsTimestamp(...args),
  };
});

// Real rebuild pulls in the whole barrel — stand in a minimal node_id-index read.
vi.mock('../../../resources/js/indexedDB/hydration/rebuild', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  return {
    getNodesByDataNodeIDs: async (ids) => {
      const db = await conn.openDatabase();
      const index = db.transaction('nodes', 'readonly').objectStore('nodes').index('node_id');
      const rows = await Promise.all(ids.map((id) => new Promise((res, rej) => {
        const req = index.get(id);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      })));
      return rows.filter(Boolean);
    },
  };
});

import {
  sliceNodeCleanText,
  getSuggestionSegments,
  saveSuggestion,
  withdrawSuggestion,
  resolveSuggestion,
  getHighlightRecord,
} from '../../../resources/js/hyperlights/suggestedEdit.ts';

const BOOK = 'book_sugg_test';
const HL = 'HL_777';
const NODE_A = `${BOOK}_1_aaaa`;
const NODE_B = `${BOOK}_2_bbbb`;

const nodeContent = (nodeId, inner) => `<p data-node-id="${nodeId}">${inner}</p>`;

function seedFixture({ charData, suggested = null, status = null, nodes } = {}) {
  const hl = {
    book: BOOK,
    hyperlight_id: HL,
    node_id: Object.keys(charData),
    charData,
    highlightedText: 'irrelevant concatenation',
    highlightedHTML: '',
    annotation: '',
    suggested_text: suggested,
    suggestion_status: status,
  };
  return Promise.all([
    seedStore('hyperlights', [hl]),
    seedStore('nodes', nodes),
  ]);
}

beforeEach(() => {
  installFreshIndexedDB();
  queueForSync.mockClear();
  updateAnnotationsTimestamp.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sliceNodeCleanText', () => {
  it('slices plain textContent across inline tags', () => {
    const content = nodeContent(NODE_A, 'Hello <b>bold</b> world');
    //               textContent: "Hello bold world"
    expect(sliceNodeCleanText(content, 6, 10)).toBe('bold');
    expect(sliceNodeCleanText(content, 0, 16)).toBe('Hello bold world');
  });

  it('offsets COUNT footnote sup digits (calculateCleanTextOffset parity)', () => {
    const content = nodeContent(NODE_A, 'before<sup fn-count-id="fn1">12</sup>after');
    // textContent: "before12after" — the sup digits occupy offsets 6..8.
    expect(sliceNodeCleanText(content, 0, 8)).toBe('before12');
    expect(sliceNodeCleanText(content, 8, 13)).toBe('after');
  });

  it('decodes entities the way textContent does', () => {
    const content = nodeContent(NODE_A, 'salt &amp; pepper');
    expect(sliceNodeCleanText(content, 5, 6)).toBe('&');
  });
});

describe('getSuggestionSegments', () => {
  it('returns an editable per-node segment with the live original slice', async () => {
    await seedFixture({
      charData: { [NODE_A]: { charStart: 6, charEnd: 11 }, [NODE_B]: { charStart: 0, charEnd: 5 } },
      nodes: [
        { book: BOOK, startLine: 1, chunk_id: 0, node_id: NODE_A, content: nodeContent(NODE_A, 'Hello world tail'), hyperlights: [], hypercites: [], footnotes: [] },
        { book: BOOK, startLine: 2, chunk_id: 0, node_id: NODE_B, content: nodeContent(NODE_B, 'Start of second'), hyperlights: [], hypercites: [], footnotes: [] },
      ],
    });

    const record = await getHighlightRecord(HL);
    const segments = await getSuggestionSegments(record);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ nodeId: NODE_A, originalText: 'world', editable: true, suggestedText: 'world' });
    expect(segments[1]).toMatchObject({ nodeId: NODE_B, originalText: 'Start', editable: true });
  });

  it('marks ghost (-1) anchors, missing nodes, and latex nodes non-editable', async () => {
    const NODE_C = `${BOOK}_3_cccc`;
    await seedFixture({
      charData: {
        [NODE_A]: { charStart: -1, charEnd: -1 },
        [NODE_B]: { charStart: 0, charEnd: 4 },
        [NODE_C]: { charStart: 0, charEnd: 4 },
      },
      nodes: [
        { book: BOOK, startLine: 1, chunk_id: 0, node_id: NODE_A, content: nodeContent(NODE_A, 'ghosted'), hyperlights: [], hypercites: [], footnotes: [] },
        // NODE_B record deliberately missing.
        { book: BOOK, startLine: 3, chunk_id: 0, node_id: NODE_C, content: nodeContent(NODE_C, 'math <latex data-math="x^2">x²</latex>'), hyperlights: [], hypercites: [], footnotes: [] },
      ],
    });

    const record = await getHighlightRecord(HL);
    const segments = await getSuggestionSegments(record);
    expect(segments.map((s) => s.editable)).toEqual([false, false, false]);
    expect(segments[0].reason).toMatch(/deleted/);
    expect(segments[1].reason).toMatch(/not available/);
    expect(segments[2].reason).toMatch(/math/);
  });

  it('pre-fills suggestedText and storedBefore from an existing suggestion', async () => {
    await seedFixture({
      charData: { [NODE_A]: { charStart: 0, charEnd: 5 } },
      suggested: { [NODE_A]: { before: 'Hello at snapshot time', after: 'Howdy' } },
      status: 'pending',
      nodes: [
        { book: BOOK, startLine: 1, chunk_id: 0, node_id: NODE_A, content: nodeContent(NODE_A, 'Hello world'), hyperlights: [], hypercites: [], footnotes: [] },
      ],
    });

    const record = await getHighlightRecord(HL);
    const [segment] = await getSuggestionSegments(record);
    expect(segment.suggestedText).toBe('Howdy');
    expect(segment.storedBefore).toBe('Hello at snapshot time');
  });
});

describe('saveSuggestion', () => {
  const twoNodeFixture = () => seedFixture({
    charData: { [NODE_A]: { charStart: 6, charEnd: 11 }, [NODE_B]: { charStart: 0, charEnd: 5 } },
    nodes: [
      { book: BOOK, startLine: 1, chunk_id: 0, node_id: NODE_A, content: nodeContent(NODE_A, 'Hello world tail'), hyperlights: [], hypercites: [], footnotes: [] },
      { book: BOOK, startLine: 2, chunk_id: 0, node_id: NODE_B, content: nodeContent(NODE_B, 'Start of second'), hyperlights: [], hypercites: [], footnotes: [] },
    ],
  });

  it('stores {before, after} only for CHANGED nodes and derives pending', async () => {
    await twoNodeFixture();

    const result = await saveSuggestion(HL, {
      [NODE_A]: 'cosmos', // changed ("world" → "cosmos")
      [NODE_B]: 'Start', // identical — dropped
    });

    expect(result).toBe('saved');
    const [record] = await readAll('hyperlights');
    expect(record.suggestion_status).toBe('pending');
    expect(record.suggested_text).toEqual({
      [NODE_A]: { before: 'world', after: 'cosmos' },
    });
    expect(queueForSync).toHaveBeenCalledWith('hyperlights', HL, 'update', expect.objectContaining({ suggestion_status: 'pending' }));
    expect(updateAnnotationsTimestamp).toHaveBeenCalledWith(BOOK);
  });

  it('an all-identical save withdraws (empty map ⇒ null/null)', async () => {
    await twoNodeFixture();

    const result = await saveSuggestion(HL, { [NODE_A]: 'world', [NODE_B]: 'Start' });

    expect(result).toBe('withdrawn');
    const [record] = await readAll('hyperlights');
    expect(record.suggested_text).toBeNull();
    expect(record.suggestion_status).toBeNull();
  });

  it('re-editing keeps the ORIGINAL before snapshot', async () => {
    await seedFixture({
      charData: { [NODE_A]: { charStart: 6, charEnd: 11 } },
      suggested: { [NODE_A]: { before: 'world-as-first-seen', after: 'galaxy' } },
      status: 'pending',
      nodes: [
        { book: BOOK, startLine: 1, chunk_id: 0, node_id: NODE_A, content: nodeContent(NODE_A, 'Hello world tail'), hyperlights: [], hypercites: [], footnotes: [] },
      ],
    });

    await saveSuggestion(HL, { [NODE_A]: 'universe' });

    const [record] = await readAll('hyperlights');
    expect(record.suggested_text[NODE_A]).toEqual({ before: 'world-as-first-seen', after: 'universe' });
  });

  it('withdrawSuggestion clears both fields and queues the sync', async () => {
    await seedFixture({
      charData: { [NODE_A]: { charStart: 0, charEnd: 5 } },
      suggested: { [NODE_A]: { before: 'Hello', after: 'Howdy' } },
      status: 'pending',
      nodes: [
        { book: BOOK, startLine: 1, chunk_id: 0, node_id: NODE_A, content: nodeContent(NODE_A, 'Hello world'), hyperlights: [], hypercites: [], footnotes: [] },
      ],
    });

    await withdrawSuggestion(HL);

    const [record] = await readAll('hyperlights');
    expect(record.suggested_text).toBeNull();
    expect(record.suggestion_status).toBeNull();
    expect(queueForSync).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSuggestion', () => {
  const pendingFixture = () => seedFixture({
    charData: { [NODE_A]: { charStart: 0, charEnd: 5 } },
    suggested: { [NODE_A]: { before: 'Hello', after: 'Howdy' } },
    status: 'pending',
    nodes: [
      { book: BOOK, startLine: 1, chunk_id: 0, node_id: NODE_A, content: nodeContent(NODE_A, 'Hello world'), hyperlights: [], hypercites: [], footnotes: [] },
    ],
  });

  it('POSTs the verdict, drains the body, and mirrors status into IDB without queueForSync', async () => {
    await pendingFixture();
    const text = vi.fn().mockResolvedValue('{"success":true}');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text });
    vi.stubGlobal('fetch', fetchMock);

    await resolveSuggestion(BOOK, HL, 'accepted');

    expect(fetchMock).toHaveBeenCalledWith('/api/db/hyperlights/suggestion/resolve', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ book: BOOK, hyperlight_id: HL, resolution: 'accepted' }),
    }));
    expect(text).toHaveBeenCalled(); // body consumed (fetch-drain gate)
    const [record] = await readAll('hyperlights');
    expect(record.suggestion_status).toBe('accepted');
    expect(record.suggested_text).not.toBeNull(); // retained for the before/after render
    expect(queueForSync).not.toHaveBeenCalled();
  });

  it('a non-OK response throws, drains, and leaves the local status untouched', async () => {
    await pendingFixture();
    const text = vi.fn().mockResolvedValue('{"error":"Suggestion is not pending"}');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, text }));

    await expect(resolveSuggestion(BOOK, HL, 'rejected')).rejects.toThrow(/422/);
    expect(text).toHaveBeenCalled();
    const [record] = await readAll('hyperlights');
    expect(record.suggestion_status).toBe('pending');
  });
});
