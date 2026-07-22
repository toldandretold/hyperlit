/**
 * Ghost detection for hyperlights (hyperlights/myHighlights/ghost.ts).
 *
 * A highlight is GHOSTED when NONE of its per-node entries resolve against
 * current node content — computed at display time, never stored. An entry
 * resolves only when its range fits AND the highlight's text still exists
 * (at the range, or anywhere in the node — offsets may shift under edits).
 * The content check is what catches MID-NODE deletion, where the paragraph
 * stays longer than charStart but the highlighted words are gone (the
 * KARL-MARX-paragraph case that a length-only test called "live").
 * Conservative rules: unjudgeable cases (missing charData, latex nodes, IDB
 * errors, too-short text) never false-ghost; node_id lookups filter to the
 * record's own book (node_id repeats across parent/sub-books in IDB).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { entryResolves, computeGhosted, isHighlightGhosted, partitionGhosts } from '../../../../resources/js/hyperlights/myHighlights/ghost';
import { installFreshIndexedDB, seedStore } from '../../indexedDB/idbHarness';

const LONG_TEXT = 'KARL MARX developed the theory of historical materialism over many years of study';
const LONG_HTML = `<p>${LONG_TEXT}</p>`;
// 'theory of historical materialism' occupies chars 24..56 of LONG_TEXT
const HL_TEXT = 'theory of historical materialism';

describe('entryResolves (pure)', () => {
  it('resolves when the highlighted text sits exactly at the range', () => {
    expect(entryResolves({
      charStart: 24, charEnd: 56, nodeContent: LONG_HTML, highlightedText: HL_TEXT,
    })).toBe(true);
  });

  it('resolves when offsets shifted but the whole text survives elsewhere in the node', () => {
    // An earlier-in-node edit shifted everything; the phrase still exists.
    expect(entryResolves({
      charStart: 5, charEnd: 37, nodeContent: LONG_HTML, highlightedText: HL_TEXT,
    })).toBe(true);
  });

  it('does NOT resolve on mid-node deletion (range fits, but the words are gone)', () => {
    // The highlighted phrase was deleted; the paragraph is still longer than
    // charStart — the length-only test wrongly called this "live".
    const edited = '<p>KARL MARX developed many other ideas over many years of diligent study and writing</p>';
    expect(entryResolves({
      charStart: 24, charEnd: 56, nodeContent: edited, highlightedText: HL_TEXT,
    })).toBe(false);
  });

  it('does not resolve when charStart is beyond the text', () => {
    expect(entryResolves({
      charStart: 500, charEnd: 510, nodeContent: '<p>short</p>', highlightedText: HL_TEXT,
    })).toBe(false);
  });

  it('does not resolve when charEnd is truncated by a shortening edit', () => {
    expect(entryResolves({
      charStart: 2, charEnd: 900, nodeContent: LONG_HTML, highlightedText: HL_TEXT,
    })).toBe(false);
  });

  it('does not resolve when the node is missing (null content)', () => {
    expect(entryResolves({ charStart: 0, charEnd: 5, nodeContent: null, highlightedText: HL_TEXT })).toBe(false);
  });

  it('server tombstone (-1/-1 from CharDataRecalculator) is a deterministic ghost', () => {
    expect(entryResolves({ charStart: -1, charEnd: -1, nodeContent: LONG_HTML, highlightedText: HL_TEXT })).toBe(false);
  });

  it('entities decode before offsets apply (nbsp does not shift the slice)', () => {
    // "A&nbsp;B theory of historical materialism" — textContent: "A B theory of..."
    const content = '<p>A&nbsp;B theory of historical materialism tail</p>';
    expect(entryResolves({
      charStart: 4, charEnd: 36, nodeContent: content, highlightedText: HL_TEXT,
    })).toBe(true);
  });

  it('latex content always resolves (KaTeX makes length math untrustworthy)', () => {
    expect(entryResolves({
      charStart: 9999, charEnd: 10000, nodeContent: '<p><latex data-math="x^2"></latex></p>', highlightedText: HL_TEXT,
    })).toBe(true);
  });

  it('too-short highlightedText falls back to the range-fit test only', () => {
    expect(entryResolves({
      charStart: 2, charEnd: 4, nodeContent: LONG_HTML, highlightedText: 'ab',
    })).toBe(true);
  });
});

describe('computeGhosted (pure)', () => {
  const live = { charStart: 24, charEnd: 56, nodeContent: LONG_HTML, highlightedText: HL_TEXT };
  const dead = { charStart: 900, charEnd: 910, nodeContent: '<p>tiny</p>', highlightedText: HL_TEXT };
  const gone = { charStart: 0, charEnd: 5, nodeContent: null, highlightedText: HL_TEXT };

  it('not ghosted when all entries resolve', () => {
    expect(computeGhosted([live, live])).toBe(false);
  });

  it('not ghosted when at least one entry resolves', () => {
    expect(computeGhosted([dead, live, gone])).toBe(false);
  });

  it('ghosted when no entry resolves', () => {
    expect(computeGhosted([dead, gone])).toBe(true);
  });

  it('empty charData is NOT ghosted (unjudgeable → live)', () => {
    expect(computeGhosted([])).toBe(false);
  });
});

describe('isHighlightGhosted / partitionGhosts (IDB)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
  });

  const BOOK = 'book_ghost_test';

  function hl(id, charData, extra = {}) {
    return {
      book: BOOK,
      hyperlight_id: id,
      node_id: Object.keys(charData),
      charData,
      highlightedText: HL_TEXT,
      highlightedHTML: `<mark>${HL_TEXT}</mark>`,
      annotation: '',
      ...extra,
    };
  }

  function node(nodeId, content, startLine = 100) {
    return { book: BOOK, startLine, chunk_id: 0, node_id: nodeId, content, hyperlights: [], hypercites: [], footnotes: [] };
  }

  it('ghosts a highlight whose text was deleted mid-node (range still fits)', async () => {
    await seedStore('nodes', [
      node('n1', '<p>KARL MARX developed many other ideas over many years of diligent study and writing here</p>'),
    ]);
    const record = hl('HL_mid', { n1: { charStart: 24, charEnd: 56 } });
    expect(await isHighlightGhosted(record)).toBe(true);
  });

  it('keeps a highlight live when its text is still in place', async () => {
    await seedStore('nodes', [node('n1', LONG_HTML)]);
    const record = hl('HL_live', { n1: { charStart: 24, charEnd: 56 } });
    expect(await isHighlightGhosted(record)).toBe(false);
  });

  it('keeps a highlight live when one of two node entries still resolves', async () => {
    await seedStore('nodes', [
      node('n1', '<p>tiny</p>', 100),
      node('n2', LONG_HTML, 200),
    ]);
    const record = hl('HL_multi', {
      n1: { charStart: 900, charEnd: 910 },
      n2: { charStart: 24, charEnd: 56 },
    });
    expect(await isHighlightGhosted(record)).toBe(false);
  });

  it('ghosts a highlight whose node no longer exists at all', async () => {
    const record = hl('HL_gone', { vanished: { charStart: 0, charEnd: 5 } });
    expect(await isHighlightGhosted(record)).toBe(true);
  });

  it('only counts nodes from the record\'s own book (cross-book node_id collision)', async () => {
    await seedStore('nodes', [
      { ...node('shared', `<p>${LONG_TEXT}</p>`), book: 'other_book' },
    ]);
    const record = hl('HL_x', { shared: { charStart: 24, charEnd: 56 } });
    expect(await isHighlightGhosted(record)).toBe(true);
  });

  it('partitionGhosts splits live and ghosted', async () => {
    await seedStore('nodes', [node('n1', LONG_HTML)]);
    const liveRec = hl('HL_a', { n1: { charStart: 24, charEnd: 56 } });
    const ghostRec = hl('HL_b', { n1: { charStart: 800, charEnd: 810 } });
    const { live, ghosts } = await partitionGhosts([liveRec, ghostRec]);
    expect(live.map((r) => r.hyperlight_id)).toEqual(['HL_a']);
    expect(ghosts.map((r) => r.hyperlight_id)).toEqual(['HL_b']);
  });

  it('treats a record with no charData as live (unjudgeable)', async () => {
    const record = hl('HL_nocd', {});
    expect(await isHighlightGhosted(record)).toBe(false);
  });
});
