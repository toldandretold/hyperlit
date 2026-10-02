/**
 * Render-time `translate="no"` on the parts of a node that are NOT prose.
 *
 * A footnote MARKER is a number. Translating it breaks the link between marker
 * and definition outright, and for a target language with its own numerals
 * (Arabic-Indic, Devanagari) the marker stops matching anything at all. It also
 * fights `applyDynamicFootnoteNumbers`, which rewrites the anchor's text
 * whenever it disagrees with the stored attribute: translate the digit → we
 * rewrite it to Latin → the translator rewrites it again, a loop that only the
 * one-attempt heal latch currently stops by accident.
 *
 * The hypercite arrow and `<latex>` are the same kind of thing — glyphs whose
 * meaning is positional or mathematical rather than linguistic. (`<latex>`'s
 * truth is its `data-math` attribute; KaTeX only injects display glyphs.)
 *
 * The attribute is render-time ONLY. `contentProcessor` strips it on save, and
 * `NodeHtmlSanitizer` is denylist-based so nothing server-side would catch a
 * leak — see the companion assertion in batchUpdate.characterization.test.js.
 * `TextController::markUntranslatableGlyphs` does the same marking for the
 * server-prerendered chunk; keep the two selectors in step.
 *
 * Render-only deps are stubbed, matching renderInPlace.test.js.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/convertMarkdown', () => ({
  renderBlockToHtml: (node) => `<p id="${node.startLine}">${node.content ?? ''}</p>`,
}));
vi.mock('../../../resources/js/utilities/sanitizeConfig', () => ({ sanitizeHtml: (h) => h }));
vi.mock('../../../resources/js/lazyLoader/footnoteSelfHeal', () => ({ applyDynamicFootnoteNumbers: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/chartRenderer', () => ({ renderCharts: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/imageState', () => ({ handleBrokenImages: vi.fn() }));
vi.mock('../../../resources/js/components/utilities/gateFilter', () => ({ applyGateFilter: (x) => x }));
vi.mock('../../../resources/js/utilities/operationState', () => ({ isNewlyCreatedHighlight: () => false }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));

import { createChunkElement } from '../../../resources/js/lazyLoader/chunkRender';

const nodeWith = (inner) => ({
  book: 'bookA', chunk_id: 1, startLine: 100, node_id: 'bookA_n100',
  content: inner, plainText: 'x', type: null,
  footnotes: [], hypercites: [], hyperlights: [],
});

describe('chunk render marks non-prose glyphs untranslatable', () => {
  it('marks a footnote marker AND its inner anchor', () => {
    const chunk = createChunkElement([nodeWith(
      'A sentence<sup fn-count-id="7" id="Fn7"><a class="footnote-ref" href="#Fn7">7</a></sup>',
    )], { bookId: 'bookA' });

    expect(chunk.querySelector('sup[fn-count-id]').getAttribute('translate')).toBe('no');
    expect(chunk.querySelector('a.footnote-ref').getAttribute('translate')).toBe('no');
  });

  it('marks the hypercite arrow and latex elements', () => {
    // data-math is base64 (renderMathElements atob()s it), not raw LaTeX.
    const math = btoa('e^{i\\pi}');
    const chunk = createChunkElement([nodeWith(
      `Cited <a class="open-icon" href="#x">↗</a> and <latex data-math="${math}"></latex>`,
    )], { bookId: 'bookA' });

    expect(chunk.querySelector('.open-icon').getAttribute('translate')).toBe('no');
    expect(chunk.querySelector('latex').getAttribute('translate')).toBe('no');
  });

  it('leaves the PROSE translatable — the book is the thing a reader wants translated', () => {
    const chunk = createChunkElement([nodeWith(
      'Real prose<sup fn-count-id="1" id="Fn1">1</sup>',
    )], { bookId: 'bookA' });

    const p = chunk.querySelector('p#100');
    expect(p).not.toBeNull();
    expect(p.hasAttribute('translate')).toBe(false);
    // and the node root / chunk wrapper are not blanket-marked either
    expect(chunk.hasAttribute('translate')).toBe(false);
  });
});
