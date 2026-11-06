/**
 * Accept-splice machinery (resources/js/hyperlights/suggestedEditAccept.ts):
 * the pure range splice + view shifting, and acceptSuggestion end-to-end over
 * fake-indexeddb — path B (unrendered node → explicit html + chunk_id), path A
 * (rendered node → DOM splice, batch without html), drift refusal, idempotent
 * re-entry, and the splice-first/resolve-second ordering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readAll } from '../indexedDB/idbHarness.js';

const batchUpdateIndexedDBRecords = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  return {
    openDatabase: conn.openDatabase,
    queueForSync: vi.fn(),
    updateAnnotationsTimestamp: vi.fn(),
    batchUpdateIndexedDBRecords: (...args) => batchUpdateIndexedDBRecords(...args),
  };
});

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

vi.mock('../../../resources/js/utilities/externalTranslation', () => ({
  isExternallyTranslated: () => false,
}));
vi.mock('../../../resources/js/utilities/staleBookGate', () => ({
  isBookStaleForEdit: () => false,
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  canUserEditBook: vi.fn().mockResolvedValue(true),
}));
// Mark re-application: identity passthrough keeps the spliced HTML inspectable.
vi.mock('../../../resources/js/lazyLoader/index', () => ({
  applyHighlights: (html) => html,
  applyHypercites: (html) => html,
}));
vi.mock('../../../resources/js/hypercites/index', () => ({
  attachUnderlineClickListeners: vi.fn(),
}));
vi.mock('../../../resources/js/hyperlights/listeners', () => ({
  attachMarkListeners: vi.fn(),
}));

import {
  spliceCleanTextRange,
  shiftRangeForSplice,
  acceptSuggestion,
  revertSuggestion,
} from '../../../resources/js/hyperlights/suggestedEditAccept.ts';

const BOOK = 'book_accept_test';
const HL = 'HL_accept';
const NODE_A = `${BOOK}_1_aaaa`;

function seedAcceptFixture({ before = 'world', after = 'cosmos', content, charData, status = 'pending' } = {}) {
  const nodeContent = content ?? `<p data-node-id="${NODE_A}">Hello world tail</p>`;
  return Promise.all([
    seedStore('hyperlights', [{
      book: BOOK,
      hyperlight_id: HL,
      node_id: [NODE_A],
      charData: charData ?? { [NODE_A]: { charStart: 6, charEnd: 11 } },
      highlightedText: before,
      highlightedHTML: before,
      annotation: '',
      suggested_text: { [NODE_A]: { before, after } },
      suggestion_status: status,
    }]),
    seedStore('nodes', [{
      book: BOOK,
      startLine: 1,
      chunk_id: 3,
      node_id: NODE_A,
      content: nodeContent,
      hyperlights: [{ highlightID: HL, charStart: 6, charEnd: 11 }],
      hypercites: [],
      footnotes: [],
    }]),
  ]);
}

function stubResolveFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  installFreshIndexedDB();
  batchUpdateIndexedDBRecords.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('spliceCleanTextRange', () => {
  it('replaces the range and preserves inline HTML outside it', () => {
    const el = document.createElement('p');
    el.innerHTML = 'Hello <b>brave</b> world tail';
    // textContent: "Hello brave world tail" — "world" = 12..17
    spliceCleanTextRange(el, 12, 17, 'cosmos', 'world');
    expect(el.textContent).toBe('Hello brave cosmos tail');
    expect(el.querySelector('b')?.textContent).toBe('brave');
  });

  it('works across split text nodes', () => {
    const el = document.createElement('p');
    el.appendChild(document.createTextNode('Hello '));
    el.appendChild(document.createTextNode('world'));
    el.appendChild(document.createTextNode(' tail'));
    spliceCleanTextRange(el, 4, 8, 'X', 'o wo');
    expect(el.textContent).toBe('HellXrld tail');
  });

  it('consumes elements strictly inside the range (footnote sup)', () => {
    const el = document.createElement('p');
    el.innerHTML = 'before<sup fn-count-id="fn1">1</sup>after';
    // textContent "before1after": replace "e1a" (5..8)
    spliceCleanTextRange(el, 5, 8, 'X', 'e1a');
    expect(el.querySelector('sup')).toBeNull();
    expect(el.textContent).toBe('beforXfter');
  });

  it('aborts when the range text does not match the expected original', () => {
    const el = document.createElement('p');
    el.textContent = 'Hello DRIFTED tail';
    expect(() => spliceCleanTextRange(el, 6, 11, 'cosmos', 'world'))
      .toThrow(/changed since/);
    expect(el.textContent).toBe('Hello DRIFTED tail');
  });
});

describe('shiftRangeForSplice', () => {
  const splice = (range) => shiftRangeForSplice(range, 10, 20, 4); // delta = -6

  it('leaves ranges wholly before untouched', () => {
    expect(splice({ charStart: 0, charEnd: 10 })).toEqual({ charStart: 0, charEnd: 10 });
  });
  it('shifts ranges wholly after by the delta', () => {
    expect(splice({ charStart: 25, charEnd: 30 })).toEqual({ charStart: 19, charEnd: 24 });
  });
  it('tombstones ranges swallowed by the splice', () => {
    expect(splice({ charStart: 12, charEnd: 18 })).toEqual({ charStart: -1, charEnd: -1 });
  });
  it('clips a range ending inside the splice at the splice start', () => {
    expect(splice({ charStart: 2, charEnd: 15 })).toEqual({ charStart: 2, charEnd: 10 });
  });
  it('moves a range starting inside the splice to after the replacement', () => {
    expect(splice({ charStart: 15, charEnd: 28 })).toEqual({ charStart: 14, charEnd: 22 });
  });
  it('a spanning range keeps both sides and absorbs the delta', () => {
    expect(splice({ charStart: 5, charEnd: 25 })).toEqual({ charStart: 5, charEnd: 19 });
  });
  it('passes tombstones through', () => {
    expect(splice({ charStart: -1, charEnd: -1 })).toEqual({ charStart: -1, charEnd: -1 });
  });
});

describe('acceptSuggestion — path B (node not rendered)', () => {
  it('splices the stored content, passes explicit html + chunk_id, then resolves', async () => {
    await seedAcceptFixture();
    const fetchMock = stubResolveFetch();

    const outcome = await acceptSuggestion(HL);

    expect(outcome.status).toBe('done');
    expect(outcome.applied).toEqual([NODE_A]);
    expect(outcome.skipped).toEqual([]);

    expect(batchUpdateIndexedDBRecords).toHaveBeenCalledTimes(1);
    const [records, options] = batchUpdateIndexedDBRecords.mock.calls[0];
    expect(String(records[0].id)).toBe('1');
    expect(records[0].html).toContain('Hello cosmos tail');
    expect(records[0].chunk_id).toBe(3); // explicit — determineChunkIdFromDOM is blind here
    expect(options).toMatchObject({ bookId: BOOK, source: 'edit' });

    // Resolve fired after the splice.
    expect(fetchMock).toHaveBeenCalledWith('/api/db/hyperlights/suggestion/resolve', expect.anything());
    const [hl] = await readAll('hyperlights');
    expect(hl.suggestion_status).toBe('accepted');
    // The suggestion's own anchor moved to the replacement span.
    expect(hl.charData[NODE_A]).toEqual({ charStart: 6, charEnd: 12 });
  });

  it('refuses a drifted node (live text matches neither before nor after) and does NOT resolve', async () => {
    await seedAcceptFixture({
      content: `<p data-node-id="${NODE_A}">Hello DRIFT tail x</p>`,
    });
    const fetchMock = stubResolveFetch();

    const outcome = await acceptSuggestion(HL);

    expect(outcome.status).toBe('done');
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped[0].reason).toMatch(/changed since/);
    expect(batchUpdateIndexedDBRecords).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const [hl] = await readAll('hyperlights');
    expect(hl.suggestion_status).toBe('pending');
  });

  it('a node whose live text already equals AFTER counts as applied (retry after failed resolve)', async () => {
    await seedAcceptFixture({
      content: `<p data-node-id="${NODE_A}">Hello cosmos tail</p>`,
      charData: { [NODE_A]: { charStart: 6, charEnd: 12 } },
    });
    const fetchMock = stubResolveFetch();

    const outcome = await acceptSuggestion(HL);

    expect(outcome.applied).toEqual([NODE_A]);
    expect(batchUpdateIndexedDBRecords).not.toHaveBeenCalled(); // nothing to splice
    expect(fetchMock).toHaveBeenCalled(); // but the verdict is still recorded
  });

  it('blocks when the viewer cannot edit the book', async () => {
    await seedAcceptFixture();
    stubResolveFetch();
    const { canUserEditBook } = await import('../../../resources/js/utilities/auth/index');
    canUserEditBook.mockResolvedValueOnce(false);

    const outcome = await acceptSuggestion(HL);
    expect(outcome.status).toBe('blocked');
    expect(batchUpdateIndexedDBRecords).not.toHaveBeenCalled();
  });
});

describe('acceptSuggestion — path A (rendered node)', () => {
  it('splices the live DOM and persists WITHOUT explicit html (DOM is the truth)', async () => {
    await seedAcceptFixture();
    const fetchMock = stubResolveFetch();

    document.body.innerHTML = `
      <div data-book-id="${BOOK}">
        <div class="chunk"><p id="1" data-node-id="${NODE_A}">Hello <mark class="${HL}">world</mark> tail</p></div>
      </div>`;

    const outcome = await acceptSuggestion(HL);

    expect(outcome.applied).toEqual([NODE_A]);
    const nodeEl = document.querySelector('[id="1"]');
    expect(nodeEl.textContent).toBe('Hello cosmos tail');

    const [records, options] = batchUpdateIndexedDBRecords.mock.calls[0];
    expect(records[0].html).toBeUndefined();
    expect(options).toMatchObject({ bookId: BOOK, source: 'edit' });
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('revertSuggestion', () => {
  it('splices after→before on an ACCEPTED suggestion and returns it to pending', async () => {
    await seedAcceptFixture({
      status: 'accepted',
      content: `<p data-node-id="${NODE_A}">Hello cosmos tail</p>`,
      charData: { [NODE_A]: { charStart: 6, charEnd: 12 } }, // anchored to "cosmos"
    });
    const fetchMock = stubResolveFetch();

    const outcome = await revertSuggestion(HL);

    expect(outcome.status).toBe('done');
    expect(outcome.applied).toEqual([NODE_A]);

    const [records] = batchUpdateIndexedDBRecords.mock.calls[0];
    expect(records[0].html).toContain('Hello world tail'); // original restored

    // Verdict: back to pending.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.resolution).toBe('pending');
    const [hl] = await readAll('hyperlights');
    expect(hl.suggestion_status).toBe('pending');
    expect(hl.suggested_text).not.toBeNull(); // pair retained — re-acceptable
    // Anchor back on the original span length.
    expect(hl.charData[NODE_A]).toEqual({ charStart: 6, charEnd: 11 });
  });

  it('refuses when the suggestion is not accepted', async () => {
    await seedAcceptFixture(); // pending
    stubResolveFetch();

    const outcome = await revertSuggestion(HL);
    expect(outcome.status).toBe('blocked');
    expect(outcome.reason).toMatch(/accepted/);
    expect(batchUpdateIndexedDBRecords).not.toHaveBeenCalled();
  });

  it('refuses a node that drifted after acceptance and does NOT flip the status', async () => {
    await seedAcceptFixture({
      status: 'accepted',
      content: `<p data-node-id="${NODE_A}">Hello LATER-EDIT tail x</p>`,
      charData: { [NODE_A]: { charStart: 6, charEnd: 16 } },
    });
    const fetchMock = stubResolveFetch();

    const outcome = await revertSuggestion(HL);
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped[0].reason).toMatch(/changed since this was accepted/);
    expect(fetchMock).not.toHaveBeenCalled();
    const [hl] = await readAll('hyperlights');
    expect(hl.suggestion_status).toBe('accepted');
  });
});
