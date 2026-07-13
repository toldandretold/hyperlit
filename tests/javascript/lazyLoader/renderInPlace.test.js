/**
 * Render-in-place regression guard for the prerendered-chunk fix.
 *
 * The reader server-renders the target chunk into <main> (SEO + instant paint). On init the lazy
 * loader renders that chunk through its NORMAL path (createChunkElement) and swaps the result in
 * place over the placeholder — there is no separate "adoption" path any more.
 *
 * The bug this guards: the old adoption path applied annotations via reprocessHighlightsForNodes
 * (a highlight-DELETION helper) which `continue`s past any node with no highlights BEFORE wrapping
 * its hypercite — so a node with a CITE but NO HIGHLIGHT lost its <u id="hypercite_…">, and a
 * deep-link to that cite timed out. The canonical createChunkElement path always applies hypercites
 * (independently of highlights), so the cite is wrapped. This pins that guarantee directly.
 *
 * Render-only deps are stubbed (like chunkRender.decimal.test.js) so this stays a focused check of
 * the hypercite pass — applyHypercites/applyHighlights themselves are REAL (internal to chunkRender).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/convertMarkdown', () => ({
  renderBlockToHtml: (node) => `<p>${node.content ?? ''}</p>`,
}));
vi.mock('../../../resources/js/utilities/sanitizeConfig', () => ({ sanitizeHtml: (h) => h }));
vi.mock('../../../resources/js/lazyLoader/footnoteSelfHeal', () => ({ applyDynamicFootnoteNumbers: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/chartRenderer', () => ({ renderCharts: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/imageState', () => ({ handleBrokenImages: vi.fn() }));
vi.mock('../../../resources/js/components/utilities/gateFilter', () => ({ applyGateFilter: (x) => x }));
vi.mock('../../../resources/js/utilities/operationState', () => ({ isNewlyCreatedHighlight: () => false }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));

import { createChunkElement } from '../../../resources/js/lazyLoader/chunkRender';

const citeNode = () => ({
  book: 'bookA', chunk_id: 200, startLine: 20100, node_id: 'bookA_n20100',
  content: 'Hello world', plainText: 'Hello world', type: null,
  footnotes: [],
  // A hypercite on chars 0–5 ("Hello"), and NO highlights — the exact shape the old path dropped.
  hypercites: [{ charStart: 0, charEnd: 5, hyperciteId: 'hypercite_ftx8pxb', relationshipStatus: 'single' }],
  hyperlights: [],
});

describe('canonical chunk render wraps a cite-only node (prerendered-chunk fix)', () => {
  it('wraps the hypercite <u> even though the node has zero highlights', () => {
    const chunk = createChunkElement([citeNode()], { bookId: 'bookA' });

    const u = chunk.querySelector('u#hypercite_ftx8pxb');
    expect(u).not.toBeNull();              // the cite the deep-link navigates to EXISTS
    expect(u.textContent).toBe('Hello');   // wrapped the right range
  });

  it('stamps the chunk wrapper + node id so the loader can register/replace it in place', () => {
    const chunk = createChunkElement([citeNode()], { bookId: 'bookA' });
    expect(chunk.getAttribute('data-chunk-id')).toBe('200');
    expect(chunk.querySelector('[data-node-id="bookA_n20100"]')).not.toBeNull();
    expect(chunk.hasAttribute('data-prerendered')).toBe(false); // a normal chunk, not a placeholder
  });
});
