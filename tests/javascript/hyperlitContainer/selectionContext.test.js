/**
 * buildSelectionContext — assembles the "reading context" (nesting chain +
 * in-selection citations/hypercites) sent to the AI when a user selects text.
 *
 * Locks:
 *   - the nesting chain is ordered ROOT → INNERMOST and maps marks/sub-books to
 *     highlight/footnote/ai-response levels with their author
 *   - AI-authored levels are detected via creator 'AIarchivist' OR raw_json.brain_query
 *   - the chain is capped (MAX_CHAIN_DEPTH=4) with chainTruncated set when deeper
 *   - in-selection citations resolve via resolveBibliographyTarget
 *   - the hypercite privacy gate withholds text for a private, non-owned target
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  db: null,
  library: {},   // book -> { visibility, creator, title, author }
  hypercite: {}, // 'book|id' -> { hypercitedText }
  authUser: 'sam',
}));

vi.mock('../../../resources/js/indexedDB/index', () => ({ openDatabase: async () => h.db }));
vi.mock('../../../resources/js/indexedDB/bibliography/index', () => ({
  resolveBibliographyTarget: async () => ({ type: 'library', metadata: { title: 'A Work', author: 'Smith', year: 2020 } }),
}));
vi.mock('../../../resources/js/indexedDB/hypercites/read', () => ({
  getHyperciteFromIndexedDB: async (book, id) => h.hypercite[`${book}|${id}`] ?? null,
}));
vi.mock('../../../resources/js/indexedDB/core/library', () => ({
  getLibraryObjectFromIndexedDB: async (book) => h.library[book] ?? null,
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  getAuthContextSync: () => ({ user: { name: h.authUser } }),
  getAuthContext: async () => ({ user: { name: h.authUser } }),
}));
vi.mock('../../../resources/js/hyperlitContainer/detection', () => ({
  detectHyperciteCitation: (el) => {
    const href = el.getAttribute('href') || '';
    const m = href.match(/#(hypercite_[\w-]+)/);
    return m ? { targetBook: el.getAttribute('data-target'), targetHyperciteId: m[1] } : null;
  },
}));

import { buildSelectionContext } from '../../../resources/js/hyperlitContainer/selectionContext';

// A minimal fake IDB serving hyperlights/footnotes (by index) + bibliography (by key).
function makeDb({ hyperlights = [], footnotes = [], bibliography = {} }) {
  const req = (result) => {
    const r = { onsuccess: null, onerror: null, result };
    queueMicrotask(() => r.onsuccess && r.onsuccess());
    return r;
  };
  return {
    transaction: () => ({
      objectStore: (name) => ({
        index: (idx) => ({
          getAll: (key) => req(
            (name === 'hyperlights' ? hyperlights : footnotes).filter((rec) =>
              idx === 'hyperlight_id' ? rec.hyperlight_id === key : rec.footnoteId === key,
            ),
          ),
        }),
        get: (key) => req(bibliography[Array.isArray(key) ? key.join('|') : key] ?? undefined),
      }),
    }),
  };
}

function rangeOver(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range;
}

beforeEach(() => {
  document.body.innerHTML = '';
  h.db = makeDb({});
  h.library = {};
  h.hypercite = {};
  h.authUser = 'sam';
});

describe('buildSelectionContext — nesting chain', () => {
  it('maps a highlight-in-highlight-in-footnote selection to a root→inner chain', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="book_root">
        <div class="sub-book-content" data-book-id="book_root/Fn123">
          <div class="sub-book-content" data-book-id="book_root/2/Fn123/HL_abc">
            <p>outer <mark class="HL_inner">selected words</mark> tail</p>
          </div>
        </div>
      </div>`;

    h.db = makeDb({
      hyperlights: [
        { hyperlight_id: 'HL_inner', book: 'book_root/2/Fn123/HL_abc', creator: 'sam', annotation: 'inner note' },
        { hyperlight_id: 'HL_abc', book: 'book_root/Fn123', creator: 'jo', annotation: 'jo note' },
      ],
      footnotes: [{ footnoteId: 'Fn123', book: 'book_root', content: 'footnote body' }],
    });

    const mark = document.querySelector('mark.HL_inner');
    const ctx = await buildSelectionContext(rangeOver(mark), 'book_root/2/Fn123/HL_abc');

    // root → inner
    expect(ctx.chain.map((l) => l.type)).toEqual(['footnote', 'highlight', 'highlight']);
    expect(ctx.chain[0].itemId).toBe('Fn123');
    expect(ctx.chain[2].itemId).toBe('HL_inner');
    expect(ctx.chain[2].creator).toBe('sam');
    expect(ctx.chain[1].creator).toBe('jo');
    expect(ctx.chainTruncated).toBe(false);
    expect(ctx.immediateContainer.itemId).toBe('HL_inner');
  });

  it('flags an AI Archivist response via raw_json.brain_query', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="book_root">
        <div class="sub-book-content" data-book-id="book_root/HL_ai">
          <p><mark class="HL_x">picked</mark></p>
        </div>
      </div>`;
    h.db = makeDb({
      hyperlights: [
        { hyperlight_id: 'HL_x', book: 'book_root/HL_ai', creator: 'sam', annotation: '' },
        { hyperlight_id: 'HL_ai', book: 'book_root', creator: 'sam', raw_json: { brain_query: true } },
      ],
    });

    const ctx = await buildSelectionContext(rangeOver(document.querySelector('mark.HL_x')), 'book_root/HL_ai');
    const aiLevel = ctx.chain.find((l) => l.itemId === 'HL_ai');
    expect(aiLevel.type).toBe('ai-response');
    expect(aiLevel.isAi).toBe(true);
  });

  it('flags an AI response via creator "AIarchivist"', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="book_root">
        <p><mark class="HL_ai2">picked</mark></p>
      </div>`;
    h.db = makeDb({ hyperlights: [{ hyperlight_id: 'HL_ai2', book: 'book_root', creator: 'AIarchivist' }] });

    const ctx = await buildSelectionContext(rangeOver(document.querySelector('mark.HL_ai2')), 'book_root');
    expect(ctx.chain[0].type).toBe('ai-response');
    expect(ctx.chain[0].isAi).toBe(true);
  });

  it('caps the chain at 4 levels and sets chainTruncated', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="book_root">
        <p><mark class="HL_a"><mark class="HL_b"><mark class="HL_c"><mark class="HL_d"><mark class="HL_e">deep</mark></mark></mark></mark></mark></p>
      </div>`;
    h.db = makeDb({
      hyperlights: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ hyperlight_id: `HL_${x}`, book: 'book_root', creator: x })),
    });

    const ctx = await buildSelectionContext(rangeOver(document.querySelector('mark.HL_e')), 'book_root');
    expect(ctx.chain.length).toBe(4);
    expect(ctx.chainTruncated).toBe(true);
    // Innermost is kept; outermost (HL_a) is dropped.
    expect(ctx.immediateContainer.itemId).toBe('HL_e');
    expect(ctx.chain.find((l) => l.itemId === 'HL_a')).toBeUndefined();
  });
});

describe('buildSelectionContext — in-selection links', () => {
  it('resolves a citation via resolveBibliographyTarget', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="book_root">
        <p><mark class="HL_c1">see <a class="citation-ref" id="Ref1">2020</a></mark></p>
      </div>`;
    h.db = makeDb({
      hyperlights: [{ hyperlight_id: 'HL_c1', book: 'book_root', creator: 'sam' }],
      bibliography: { 'book_root|Ref1': { book: 'book_root', referenceId: 'Ref1', content: 'Smith, A Work (2020)' } },
    });

    const ctx = await buildSelectionContext(rangeOver(document.querySelector('mark.HL_c1')), 'book_root');
    expect(ctx.citations).toHaveLength(1);
    expect(ctx.citations[0].referenceId).toBe('Ref1');
    expect(ctx.citations[0].content).toContain('Smith');
    expect(ctx.citations[0].title).toBe('A Work');
    expect(ctx.citations[0].year).toBe('2020');
  });

  it('includes hypercited text when the target book is public', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="book_root">
        <p><mark class="HL_h1">cite <a href="/book_other#hypercite_x" data-target="book_other">↗</a></mark></p>
      </div>`;
    h.db = makeDb({ hyperlights: [{ hyperlight_id: 'HL_h1', book: 'book_root', creator: 'sam' }] });
    h.library = { book_other: { visibility: 'public', creator: 'someone', title: 'Other', author: 'Auth' } };
    h.hypercite = { 'book_other|hypercite_x': { hypercitedText: 'the cited passage' } };

    const ctx = await buildSelectionContext(rangeOver(document.querySelector('mark.HL_h1')), 'book_root');
    expect(ctx.hypercites).toHaveLength(1);
    expect(ctx.hypercites[0].visibility).toBe('public');
    expect(ctx.hypercites[0].hypercitedText).toBe('the cited passage');
    expect(ctx.hypercites[0].targetBookTitle).toBe('Other');
  });

  it('withholds hypercited text when the target book is private and not owned', async () => {
    document.body.innerHTML = `
      <div class="main-content" id="book_root">
        <p><mark class="HL_h2">cite <a href="/book_secret#hypercite_y" data-target="book_secret">↗</a></mark></p>
      </div>`;
    h.db = makeDb({ hyperlights: [{ hyperlight_id: 'HL_h2', book: 'book_root', creator: 'sam' }] });
    h.library = { book_secret: { visibility: 'private', creator: 'not_sam', title: 'Secret' } };
    h.hypercite = { 'book_secret|hypercite_y': { hypercitedText: 'PRIVATE PASSAGE' } };

    const ctx = await buildSelectionContext(rangeOver(document.querySelector('mark.HL_h2')), 'book_root');
    expect(ctx.hypercites).toHaveLength(1);
    expect(ctx.hypercites[0].visibility).toBe('restricted');
    expect(ctx.hypercites[0].hypercitedText).toBeUndefined();
  });
});
