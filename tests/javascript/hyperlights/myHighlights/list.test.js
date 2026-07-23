/**
 * myHighlights list — ownership, ordering, adjacency (hyperlights/myHighlights/list.ts).
 * The data layer under the container's prev/next arrows + see-all listing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isOwnedHighlight,
  sortByDocumentOrder,
  getOwnedHighlightsForBook,
  resolveAnchorStartLine,
  hasKnownPosition,
  getAdjacent,
  getPosition,
} from '../../../../resources/js/hyperlights/myHighlights/list';
import { installFreshIndexedDB, seedStore } from '../../indexedDB/idbHarness';
import { openDatabase } from '../../../../resources/js/indexedDB/core/connection';

const NAMED = { user: { name: 'sam', username: 'samn', email: 'sam@x.y' }, userId: 'sam' };
const ANON = { user: null, userId: 'anon-token-123' };

function hl(id, extra = {}) {
  return {
    book: 'book_list_test',
    hyperlight_id: id,
    node_id: [],
    charData: {},
    highlightedText: 't',
    highlightedHTML: '<mark>t</mark>',
    annotation: '',
    ...extra,
  };
}

describe('isOwnedHighlight (pure)', () => {
  it('server flag wins', () => {
    expect(isOwnedHighlight(hl('a', { is_user_highlight: true, creator: 'someone-else' }), NAMED)).toBe(true);
  });

  it('creator matches name, username, or email', () => {
    expect(isOwnedHighlight(hl('a', { creator: 'sam' }), NAMED)).toBe(true);
    expect(isOwnedHighlight(hl('a', { creator: 'samn' }), NAMED)).toBe(true);
    expect(isOwnedHighlight(hl('a', { creator: 'sam@x.y' }), NAMED)).toBe(true);
    expect(isOwnedHighlight(hl('a', { creator: 'nemo' }), NAMED)).toBe(false);
  });

  it('anon ownership via creator_token, only when creator is empty', () => {
    expect(isOwnedHighlight(hl('a', { creator: null, creator_token: 'anon-token-123' }), ANON)).toBe(true);
    expect(isOwnedHighlight(hl('a', { creator: null, creator_token: 'other' }), ANON)).toBe(false);
    expect(isOwnedHighlight(hl('a', { creator: 'someone', creator_token: 'anon-token-123' }), ANON)).toBe(false);
  });
});

describe('sortByDocumentOrder (pure)', () => {
  it('sorts numerically across string and number startLines', () => {
    const sorted = sortByDocumentOrder([
      hl('c', { startLine: '12.5' }),
      hl('a', { startLine: 3 }),
      hl('b', { startLine: '100' }),
    ]);
    expect(sorted.map((r) => r.hyperlight_id)).toEqual(['a', 'c', 'b']);
  });

  it('unparseable startLines sort last', () => {
    const sorted = sortByDocumentOrder([
      hl('x', { startLine: null }),
      hl('y', { startLine: '200' }),
    ]);
    expect(sorted.map((r) => r.hyperlight_id)).toEqual(['y', 'x']);
  });
});

describe('getOwnedHighlightsForBook (IDB)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
  });

  it('returns only the user\'s visible highlights for the book, in document order', async () => {
    await seedStore('hyperlights', [
      hl('HL_2', { startLine: '200', creator: 'sam' }),
      hl('HL_1', { startLine: '100', creator: 'sam' }),
      hl('HL_other', { startLine: '150', creator: 'nemo' }),
      hl('HL_hidden', { startLine: '120', creator: 'sam', hidden: true }),
      { ...hl('HL_foreign', { startLine: '50', creator: 'sam' }), book: 'another_book' },
    ]);
    const result = await getOwnedHighlightsForBook('book_list_test', NAMED);
    expect(result.map((r) => r.hyperlight_id)).toEqual(['HL_1', 'HL_2']);
  });

  it('DERIVED order beats a stale stored startLine (renumbered node, unrendered highlight)', async () => {
    // HL_a's node was renumbered 100 → 500; the record's stored startLine is
    // frozen at 100 (never re-measured). Position must follow the NODE.
    await seedStore('nodes', [
      { book: 'book_list_test', startLine: 500, chunk_id: 0, node_id: 'nA', content: '<p>a</p>', hyperlights: [], hypercites: [], footnotes: [] },
      { book: 'book_list_test', startLine: 300, chunk_id: 0, node_id: 'nB', content: '<p>b</p>', hyperlights: [], hypercites: [], footnotes: [] },
    ]);
    await seedStore('hyperlights', [
      hl('HL_a', { startLine: '100', creator: 'sam', node_id: ['nA'], charData: { nA: { charStart: 0, charEnd: 1 } } }),
      hl('HL_b', { startLine: '300', creator: 'sam', node_id: ['nB'], charData: { nB: { charStart: 0, charEnd: 1 } } }),
    ]);
    const result = await getOwnedHighlightsForBook('book_list_test', NAMED);
    // Stored order says a(100) < b(300); CURRENT node order is b(300) < a(500).
    expect(result.map((r) => r.hyperlight_id)).toEqual(['HL_b', 'HL_a']);
  });

  it('a whole-node-deletion ghost positions and navigates via its surviving anchor node', async () => {
    await seedStore('nodes', [
      { book: 'book_list_test', startLine: 700, chunk_id: 0, node_id: 'nAnchor', content: '<p>survivor</p>', hyperlights: [], hypercites: [], footnotes: [] },
    ]);
    const ghost = hl('HL_ghost', {
      startLine: '100', // frozen at deletion time — must NOT win while the anchor exists
      creator: 'sam',
      node_id: ['nGone'],
      charData: { nGone: { charStart: -1, charEnd: -1 } },
      _ghost_anchor_node: 'nAnchor',
    });
    await seedStore('hyperlights', [
      ghost,
      hl('HL_live', { startLine: '700', creator: 'sam', node_id: ['nAnchor'], charData: { nAnchor: { charStart: 0, charEnd: 3 } } }),
    ]);

    // Sorts just AFTER its surviving neighbor, not at the frozen 100.
    const result = await getOwnedHighlightsForBook('book_list_test', NAMED);
    expect(result.map((r) => r.hyperlight_id)).toEqual(['HL_live', 'HL_ghost']);

    // Navigation targets the anchor node's CURRENT startLine.
    const db = await openDatabase();
    expect(await resolveAnchorStartLine(ghost, db)).toBe('700');
  });

  it('resolveAnchorStartLine falls back to the stored startLine when nothing resolves', async () => {
    const db = await openDatabase();
    const orphan = hl('HL_orphan', { startLine: '250', node_id: ['gone'], charData: { gone: { charStart: -1, charEnd: -1 } } });
    expect(await resolveAnchorStartLine(orphan, db)).toBe('250');
  });
});

describe('hasKnownPosition (IDB) — the ghost-ledger gate', () => {
  beforeEach(() => {
    installFreshIndexedDB();
  });

  const NODE = { book: 'book_list_test', startLine: 700, chunk_id: 0, node_id: 'nAlive', content: '<p>x</p>', hyperlights: [], hypercites: [], footnotes: [] };

  it('true when one of the record\'s own nodes survives', async () => {
    await seedStore('nodes', [NODE]);
    const db = await openDatabase();
    expect(await hasKnownPosition(hl('HL_a', { node_id: ['gone', 'nAlive'] }), db)).toBe(true);
  });

  it('true when only the ghost anchor survives', async () => {
    await seedStore('nodes', [NODE]);
    const db = await openDatabase();
    expect(await hasKnownPosition(
      hl('HL_g', { node_id: ['gone'], _ghost_anchor_node: 'nAlive' }), db,
    )).toBe(true);
  });

  it('false when nodes and anchor are all gone — the stored startLine does NOT count', async () => {
    await seedStore('nodes', [NODE]);
    const db = await openDatabase();
    expect(await hasKnownPosition(
      hl('HL_lost', { startLine: '250', node_id: ['gone'], _ghost_anchor_node: 'alsoGone' }), db,
    )).toBe(false);
  });

  it('false for a pre-anchor-era ghost (no anchor field at all)', async () => {
    const db = await openDatabase();
    expect(await hasKnownPosition(hl('HL_old', { startLine: '250', node_id: ['gone'] }), db)).toBe(false);
  });

  it('ignores same-node_id matches from OTHER books', async () => {
    await seedStore('nodes', [{ ...NODE, book: 'another_book' }]);
    const db = await openDatabase();
    expect(await hasKnownPosition(hl('HL_x', { node_id: ['nAlive'] }), db)).toBe(false);
  });
});

describe('getAdjacent / getPosition (pure)', () => {
  const ordered = [hl('HL_a'), hl('HL_b'), hl('HL_c')];

  it('walks next and previous', () => {
    expect(getAdjacent(ordered, 'HL_b', 1)?.record.hyperlight_id).toBe('HL_c');
    expect(getAdjacent(ordered, 'HL_b', -1)?.record.hyperlight_id).toBe('HL_a');
  });

  it('no wrap at the ends', () => {
    expect(getAdjacent(ordered, 'HL_a', -1)).toBeNull();
    expect(getAdjacent(ordered, 'HL_c', 1)).toBeNull();
  });

  it('null when the current id is absent', () => {
    expect(getAdjacent(ordered, 'HL_nope', 1)).toBeNull();
    expect(getPosition(ordered, 'HL_nope')).toBeNull();
  });

  it('position reports index and total', () => {
    expect(getPosition(ordered, 'HL_b')).toEqual({ index: 1, total: 3 });
  });
});
