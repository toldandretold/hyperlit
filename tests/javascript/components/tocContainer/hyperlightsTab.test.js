/**
 * TOC Hyperlights tab HTML (components/tocContainer/hyperlightsTab.ts
 * buildHyperlightsTabHtml) — document order preserved, ghosts flagged with 👻
 * + data-ghost, sanitized user content, truncation, annotation snippet only
 * when present, count line, empty state.
 */
import { describe, it, expect } from 'vitest';
import { buildHyperlightsTabHtml } from '../../../../resources/js/components/tocContainer/hyperlightsTab';

function hl(id, text, extra = {}) {
  return {
    book: 'b',
    hyperlight_id: id,
    node_id: [],
    charData: {},
    highlightedText: text,
    highlightedHTML: `<mark>${text}</mark>`,
    annotation: '',
    ...extra,
  };
}

describe('buildHyperlightsTabHtml', () => {
  it('renders entries in the given order with ghost flags interleaved', () => {
    const html = buildHyperlightsTabHtml(
      [hl('HL_a', 'alpha'), hl('HL_ghost', 'gone words'), hl('HL_b', 'beta')],
      new Set(['HL_ghost']),
    );
    const aIdx = html.indexOf('HL_a');
    const gIdx = html.indexOf('HL_ghost');
    const bIdx = html.indexOf('HL_b');
    expect(aIdx).toBeGreaterThan(-1);
    expect(gIdx).toBeGreaterThan(aIdx);
    expect(bIdx).toBeGreaterThan(gIdx);
    expect(html).toContain('… gone words … 👻');
    expect(html).toContain('data-ghost="true"');
    expect(html).toContain('3 hyperlights');
    expect(html).toContain('1 ghosted');
  });

  it('presents highlighted text wrapped in ellipses, not mark-styled', () => {
    const html = buildHyperlightsTabHtml([hl('HL_a', 'the phrase')], new Set());
    expect(html).toContain('… the phrase …');
  });

  it('strips markup from user content (no script injection)', () => {
    const html = buildHyperlightsTabHtml(
      [hl('HL_x', '<script>alert(1)</script>evil', { annotation: '<img onerror=x src=y>note' })],
      new Set(),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
    expect(html).toContain('evil');
    expect(html).toContain('note');
  });

  it('truncates long highlighted text', () => {
    const long = 'word '.repeat(60).trim();
    const html = buildHyperlightsTabHtml([hl('HL_long', long)], new Set());
    expect(html).not.toContain(long);
  });

  it('annotation snippet comes from preview_nodes (sub-book cache), skipping empty nodes', () => {
    const html = buildHyperlightsTabHtml([hl('HL_a', 't', {
      preview_nodes: [
        { content: '<p data-node-id="x" style="min-height:1.5em;"></p>' }, // empty seed node
        { content: '<p>the actual annotation text</p>' },
      ],
    })], new Set());
    expect(html).toContain('toc-hyperlight-note');
    expect(html).toContain('the actual annotation text');
  });

  it('falls back to the legacy annotation field; omitted entirely when nothing exists', () => {
    const legacy = buildHyperlightsTabHtml([hl('HL_a', 't', { annotation: 'legacy note' })], new Set());
    const none = buildHyperlightsTabHtml([hl('HL_b', 't', { annotation: '', preview_nodes: [] })], new Set());
    expect(legacy).toContain('legacy note');
    expect(none).not.toContain('toc-hyperlight-note');
  });

  it('empty state', () => {
    const html = buildHyperlightsTabHtml([], new Set());
    expect(html).toContain('No highlights yet');
    expect(html).not.toContain('toc-hyperlight-entry');
  });
});
