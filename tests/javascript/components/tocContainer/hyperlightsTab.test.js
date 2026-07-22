/**
 * TOC Hyperlights tab (components/tocContainer/hyperlightsTab.ts).
 *
 * buildHyperlightsTabHtml renders precomputed DisplayEntry rows — mixed
 * highlights + <u> cites in document order, ghosts flagged 👻 + data-ghost,
 * sanitized user content, "… text …" blockquote presentation, note line only
 * when present, count line, empty state. buildDisplayEntries resolves the
 * async bits: highlight notes from preview_nodes (annotations live in the
 * SUB-BOOK), cite notes as "Cited in: …" via citedIN.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildHyperlightsTabHtml, buildDisplayEntries } from '../../../../resources/js/components/tocContainer/hyperlightsTab';
import { installFreshIndexedDB, seedStore } from '../../indexedDB/idbHarness';
import { openDatabase } from '../../../../resources/js/indexedDB/core/connection';

function row(id, text, extra = {}) {
  return { id, kind: 'highlight', text, note: '', ghosted: false, ...extra };
}

describe('buildHyperlightsTabHtml (pure)', () => {
  it('renders mixed rows in the given order with ghost flags interleaved', () => {
    const html = buildHyperlightsTabHtml([
      row('HL_a', 'alpha'),
      row('hypercite_1', 'cited words', { kind: 'hypercite', note: 'Cited in: My Notes' }),
      row('HL_ghost', 'gone words', { ghosted: true }),
    ]);
    const aIdx = html.indexOf('HL_a');
    const cIdx = html.indexOf('hypercite_1');
    const gIdx = html.indexOf('HL_ghost');
    expect(aIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeGreaterThan(aIdx);
    expect(gIdx).toBeGreaterThan(cIdx);
    expect(html).toContain('… <mark>gone words</mark> … 👻');
    expect(html).toContain('data-ghost="true"');
    expect(html).toContain('data-kind="hypercite"');
    expect(html).toContain('Cited in: My Notes');
    expect(html).toContain('3 hyperlighted');
    expect(html).toContain('1 ghosted');
  });

  it('kind-codes the text: highlights in <mark>, cites in <u>, ellipses outside', () => {
    const html = buildHyperlightsTabHtml([
      row('HL_a', 'the phrase'),
      row('hypercite_z', 'the cited bit', { kind: 'hypercite' }),
    ]);
    expect(html).toContain('… <mark>the phrase</mark> …');
    expect(html).toContain('… <u>the cited bit</u> …');
  });

  it('strips markup from user content (no script injection)', () => {
    const html = buildHyperlightsTabHtml([
      row('HL_x', '<script>alert(1)</script>evil', { note: '<img onerror=x src=y>note' }),
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
    expect(html).toContain('evil');
    expect(html).toContain('note');
  });

  it('truncates long text', () => {
    const long = 'word '.repeat(60).trim();
    expect(buildHyperlightsTabHtml([row('HL_long', long)])).not.toContain(long);
  });

  it('renders the note line only when non-empty', () => {
    expect(buildHyperlightsTabHtml([row('HL_a', 't', { note: 'my note' })])).toContain('toc-hyperlight-note');
    expect(buildHyperlightsTabHtml([row('HL_b', 't')])).not.toContain('toc-hyperlight-note');
  });

  it('empty state', () => {
    const html = buildHyperlightsTabHtml([]);
    expect(html).toContain('No highlights yet');
    expect(html).not.toContain('toc-hyperlight-entry');
  });
});

describe('buildDisplayEntries (async resolution)', () => {
  beforeEach(() => {
    installFreshIndexedDB();
  });

  const BOOK = 'book_tab_test';

  it('highlight note comes from preview_nodes; cite note from citedIN with library title', async () => {
    await seedStore('nodes', [
      { book: BOOK, startLine: 100, chunk_id: 0, node_id: 'n1', content: '<p>plenty of live text right here</p>', hyperlights: [], hypercites: [], footnotes: [] },
    ]);
    await seedStore('library', [{ book: 'book_citing', title: 'My Notes' }]);
    const db = await openDatabase();

    const entries = await buildDisplayEntries([
      {
        kind: 'highlight',
        record: {
          book: BOOK, hyperlight_id: 'HL_a', node_id: ['n1'],
          charData: { n1: { charStart: 2, charEnd: 8 } },
          highlightedText: 'live text', highlightedHTML: '', annotation: '',
          preview_nodes: [
            { content: '<p style="min-height:1.5em;"></p>' }, // empty seed node — skipped
            { content: '<p>the annotation body</p>' },
          ],
        },
      },
      {
        kind: 'hypercite',
        record: {
          book: BOOK, hyperciteId: 'hypercite_x', node_id: ['n1'],
          charData: { n1: { charStart: 2, charEnd: 8 } },
          hypercitedText: 'cited bit', relationshipStatus: 'couple',
          citedIN: ['book_citing#hypercite_x'],
        },
      },
      {
        kind: 'hypercite',
        record: {
          book: BOOK, hyperciteId: 'hypercite_single', node_id: ['n1'],
          charData: { n1: { charStart: 2, charEnd: 8 } },
          hypercitedText: 'solo', relationshipStatus: 'single', citedIN: [],
        },
      },
      {
        kind: 'hypercite',
        record: {
          book: BOOK, hyperciteId: 'hypercite_ghost', node_id: ['nGone'],
          charData: { nGone: { charStart: -1, charEnd: -1 } },
          hypercitedText: 'dead cite', relationshipStatus: 'ghost',
          citedIN: ['book_citing#hypercite_ghost'],
        },
      },
    ], db);

    expect(entries[0]).toMatchObject({ id: 'HL_a', kind: 'highlight', note: 'the annotation body', ghosted: false });
    expect(entries[1]).toMatchObject({ id: 'hypercite_x', kind: 'hypercite', ghosted: false });
    expect(entries[1].note).toContain('Cited in: My Notes');
    expect(entries[2].note).toBe('Not cited anywhere yet');
    expect(entries[3]).toMatchObject({ id: 'hypercite_ghost', ghosted: true });
  });
});
