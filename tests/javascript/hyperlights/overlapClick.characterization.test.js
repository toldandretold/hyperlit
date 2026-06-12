/**
 * Characterization of overlapping-hyperlight behavior across the three layers
 * that have to agree for "click a mark → open the right highlights" to work:
 *
 *   1. RENDER  — applyHighlights (lazyLoaderFactory.js) segments overlapping
 *               highlights into disjoint <mark>s, each carrying ONLY the HL_*
 *               classes that cover that text span.
 *   2. CLICK   — handleMarkClick (hyperlights/listeners.js) reads the HL_*
 *               classes off the clicked <mark> and passes exactly those to
 *               handleUnifiedContentClick. The container then displays exactly
 *               those IDs (contentBuilders/displayHyperlights.js).
 *   3. SAVE    — collectMarkAndCitePositions (indexedDB/nodes/positionCollector.js)
 *               re-derives each highlight's charData from the live DOM when an
 *               edited node is saved.
 *
 * Layers 1 and 2 are correct: clicking an overlap segment opens only the
 * highlights covering the click point — NOT all highlights in the node.
 *
 * Layer 3 used to corrupt overlap data (the "opens everything" drift): it
 * keyed records by mark.id, but the renderer gives multi-coverage segments
 * the synthetic id="HL_overlap" and repeats the real id on every fragment of
 * a split highlight — creating phantom "HL_overlap" records, shrinking split
 * highlights (last write wins), and never updating contained ones. Fixed by
 * deriving positions per HL_* CLASS (union of segments carrying the class);
 * the SAVE tests below pin the fixed behavior, including round-trip
 * stability and the production DOM shape that exposed the bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// handleMarkClick's only heavy dependency — capture what the container is asked
// to open. Full mock (the real module's import chain — divEditor → toc.js custom
// elements — doesn't load under happy-dom); stub the other exports the rest of
// the import graph pulls from this module.
vi.mock('../../../resources/js/hyperlitContainer/index.js', () => ({
  handleUnifiedContentClick: vi.fn().mockResolvedValue(undefined),
  initializeHyperlitManager: vi.fn(),
  openHyperlitContainer: vi.fn(),
  closeHyperlitContainer: vi.fn(),
}));

// selection.js (pulled in via hyperlights/index.js) statically imports the
// editor, whose own import chain breaks under happy-dom — stub it out.
vi.mock('../../../resources/js/divEditor/index.js', () => ({
  queueNodeForSave: vi.fn(),
  startObserving: vi.fn(),
  isEditorObserving: vi.fn(() => false),
}));

import { handleUnifiedContentClick } from '../../../resources/js/hyperlitContainer/index.js';
import { handleMarkClick } from '../../../resources/js/hyperlights/listeners.js';
import { collectMarkAndCitePositions } from '../../../resources/js/indexedDB/nodes/positionCollector';
import { applyHighlights } from '../../../resources/js/lazyLoaderFactory.js';

/** Render a node's HTML with highlights applied, into a detached container. */
function renderNode(html, highlights) {
  const host = document.createElement('div');
  host.innerHTML = applyHighlights(html, highlights, 'bookA');
  return host;
}

function hl(id, charStart, charEnd) {
  // is_user_highlight: true — the gate filter (components/gateFilter.js) in its
  // 'default' mode drops non-user highlights that have no annotation, which
  // would hide our fixtures before segmentation even runs.
  return { hyperlight_id: id, charStart, charEnd, is_user_highlight: true };
}

function marksOf(host) {
  return Array.from(host.querySelectorAll('mark')).map(m => ({
    id: m.id,
    classes: Array.from(m.classList).filter(c => c.startsWith('HL_')),
    text: m.textContent,
  }));
}

describe('RENDER: applyHighlights segments overlaps correctly', () => {
  // 30 chars: "aaaaaaaaaabbbbbbbbbbcccccccccc"
  const HTML = '<p id="100" data-node-id="n-100">aaaaaaaaaabbbbbbbbbbcccccccccc</p>';

  it('non-overlapping highlights each get their own mark with one HL_ class', () => {
    const host = renderNode(HTML, [hl('HL_a', 0, 10), hl('HL_c', 20, 30)]);
    expect(marksOf(host)).toEqual([
      { id: 'HL_a', classes: ['HL_a'], text: 'aaaaaaaaaa' },
      { id: 'HL_c', classes: ['HL_c'], text: 'cccccccccc' },
    ]);
  });

  it('a contained overlap produces 3 disjoint segments; only the middle carries both classes', () => {
    // HL_outer [0,30] fully contains HL_inner [10,20]
    const host = renderNode(HTML, [hl('HL_outer', 0, 30), hl('HL_inner', 10, 20)]);
    expect(marksOf(host)).toEqual([
      { id: 'HL_outer', classes: ['HL_outer'], text: 'aaaaaaaaaa' },
      { id: 'HL_overlap', classes: ['HL_outer', 'HL_inner'], text: 'bbbbbbbbbb' },
      { id: 'HL_outer', classes: ['HL_outer'], text: 'cccccccccc' },
    ]);
    // ⚠️ Note the renderer's two id quirks that the SAVE layer mishandles below:
    // duplicate id="HL_outer" on two marks, and the synthetic id="HL_overlap".
  });

  it('a stored phantom "HL_overlap" record (pre-fix corruption residue) renders as if absent', () => {
    // Real-world shape: two real highlights + a phantom record covering part of
    // the span. Without the guard the phantom inflated data-highlight-count to 3
    // on its segment (triggering the dim-at-3+ hover rule on only PART of the
    // highlight) and added an HL_overlap class.
    const clean = renderNode(HTML, [hl('HL_a', 0, 30), hl('HL_b', 0, 30)]);
    const withPhantom = renderNode(HTML, [
      hl('HL_a', 0, 30),
      hl('HL_b', 0, 30),
      hl('HL_overlap', 15, 30),
    ]);
    expect(withPhantom.innerHTML).toBe(clean.innerHTML);
    expect(withPhantom.querySelector('mark').getAttribute('data-highlight-count')).toBe('2');
  });

  it('a partial overlap yields three segments with correct class sets', () => {
    const host = renderNode(HTML, [hl('HL_left', 0, 20), hl('HL_right', 10, 30)]);
    expect(marksOf(host)).toEqual([
      { id: 'HL_left', classes: ['HL_left'], text: 'aaaaaaaaaa' },
      { id: 'HL_overlap', classes: ['HL_left', 'HL_right'], text: 'bbbbbbbbbb' },
      { id: 'HL_right', classes: ['HL_right'], text: 'cccccccccc' },
    ]);
  });
});

describe('CLICK: handleMarkClick opens only the highlights covering the click point', () => {
  beforeEach(() => {
    vi.mocked(handleUnifiedContentClick).mockClear();
  });

  function clickEventOn(element) {
    return { preventDefault: () => {}, target: element };
  }

  it('clicking a single-coverage segment of an overlapped pair opens only that highlight', async () => {
    const host = renderNode(
      '<p id="100" data-node-id="n-100">aaaaaaaaaabbbbbbbbbbcccccccccc</p>',
      [hl('HL_outer', 0, 30), hl('HL_inner', 10, 20)]
    );
    const firstSegment = host.querySelectorAll('mark')[0];

    await handleMarkClick(clickEventOn(firstSegment));

    expect(handleUnifiedContentClick).toHaveBeenCalledTimes(1);
    const [markEl, highlightIds] = vi.mocked(handleUnifiedContentClick).mock.calls[0];
    expect(markEl).toBe(firstSegment);
    expect(highlightIds).toEqual(['HL_outer']); // NOT both — the node has 2 highlights
  });

  it('clicking the overlap segment opens exactly the overlapping highlights', async () => {
    const host = renderNode(
      '<p id="100" data-node-id="n-100">aaaaaaaaaabbbbbbbbbbcccccccccc</p>',
      [hl('HL_outer', 0, 30), hl('HL_inner', 10, 20)]
    );
    const overlapSegment = host.querySelectorAll('mark')[1];

    await handleMarkClick(clickEventOn(overlapSegment));

    const [, highlightIds] = vi.mocked(handleUnifiedContentClick).mock.calls[0];
    expect(highlightIds).toEqual(['HL_outer', 'HL_inner']);
  });

  it('a click on an element nested inside a mark (like the footnote sups in prod) resolves to that mark', async () => {
    // Highlight extends past the <em>, so the renderer wraps <em> INSIDE the mark
    // — same shape as the real-world <mark><sup class="footnote-ref">…</sup></mark>.
    const host = renderNode(
      '<p id="100" data-node-id="n-100"><em>aaaaaaaaaa</em>bbbbbbbbbbcccccccccc</p>',
      [hl('HL_a', 0, 15), hl('HL_b', 15, 20)]
    );
    const em = host.querySelector('mark em');
    expect(em).toBeTruthy();

    await handleMarkClick(clickEventOn(em));

    const [, highlightIds] = vi.mocked(handleUnifiedContentClick).mock.calls[0];
    expect(highlightIds).toEqual(['HL_a']);
  });
});

describe('SAVE: collectMarkAndCitePositions vs overlap segments (the corruption source)', () => {
  it('non-overlapping marks round-trip with correct spans', () => {
    const host = renderNode(
      '<p id="100" data-node-id="n-100">aaaaaaaaaabbbbbbbbbbcccccccccc</p>',
      [hl('HL_a', 0, 10), hl('HL_c', 20, 30)]
    );
    const { hyperlights } = collectMarkAndCitePositions(host.firstElementChild);
    expect(hyperlights).toEqual([
      { highlightID: 'HL_a', charStart: 0, charEnd: 10 },
      { highlightID: 'HL_c', charStart: 20, charEnd: 30 },
    ]);
  });

  it('an overlap NEVER produces a phantom "HL_overlap" record; both real highlights keep their full spans', () => {
    const host = renderNode(
      '<p id="100" data-node-id="n-100">aaaaaaaaaabbbbbbbbbbcccccccccc</p>',
      [hl('HL_outer', 0, 30), hl('HL_inner', 10, 20)]
    );
    const { hyperlights } = collectMarkAndCitePositions(host.firstElementChild);

    // Positions are derived per HL_* CLASS (union of all segments carrying the
    // class), never from mark.id — the renderer's synthetic id="HL_overlap" and
    // duplicate split-segment ids must not leak into the hyperlights table.
    expect(hyperlights).toEqual(
      expect.arrayContaining([
        { highlightID: 'HL_outer', charStart: 0, charEnd: 30 }, // union of 3 segments
        { highlightID: 'HL_inner', charStart: 10, charEnd: 20 }, // collected despite living only in the overlap mark
      ])
    );
    expect(hyperlights).toHaveLength(2);
  });

  it('a literal "HL_overlap" class (residue from pre-fix corrupted books) is never re-persisted', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<p id="100" data-node-id="n-100">' +
      '<mark id="HL_overlap" class="HL_1 HL_overlap">aaaaaaaaaa</mark>bbbbbbbbbbcccccccccc</p>';

    const { hyperlights } = collectMarkAndCitePositions(host.firstElementChild);

    expect(hyperlights).toEqual([{ highlightID: 'HL_1', charStart: 0, charEnd: 10 }]);
  });

  it('round trip is stable: render → collect → re-render reproduces the same marks', () => {
    const original = [hl('HL_outer', 0, 30), hl('HL_inner', 10, 20)];
    const host = renderNode(
      '<p id="100" data-node-id="n-100">aaaaaaaaaabbbbbbbbbbcccccccccc</p>',
      original
    );
    const { hyperlights } = collectMarkAndCitePositions(host.firstElementChild);

    // Feed the collected spans back through the renderer — the DOM must not
    // drift across edit/save cycles (this was the "opens everything in the
    // node" decay before the per-class fix).
    const rerendered = renderNode(
      '<p id="100" data-node-id="n-100">aaaaaaaaaabbbbbbbbbbcccccccccc</p>',
      hyperlights.map(h => hl(h.highlightID, h.charStart, h.charEnd))
    );
    expect(marksOf(rerendered)).toEqual(marksOf(host));
  });

  it('real-world shape: co-extensive highlights split across many marks by footnote sups collect cleanly', () => {
    // Mirrors the production DOM: two highlights covering the same passage,
    // rendered as a run of sibling marks (text segments + footnote sups), every
    // mark carrying BOTH classes and id="HL_overlap".
    const host = document.createElement('div');
    host.innerHTML =
      '<p id="11300" data-node-id="book_x_y_z">' +
      '<mark id="HL_overlap" class="HL_508675734 HL_782669067 hl-plausible">First sentence.</mark>' +
      '<mark id="HL_overlap" class="HL_508675734 HL_782669067 hl-plausible"><sup id="Fn_a" fn-count-id="121" class="footnote-ref">121</sup></mark>' +
      '<mark id="HL_overlap" class="HL_508675734 HL_782669067 hl-plausible"> Second sentence.</mark>' +
      '<mark id="HL_overlap" class="HL_508675734 HL_782669067 hl-plausible"><sup id="Fn_b" fn-count-id="122" class="footnote-ref">122</sup></mark>' +
      'Unhighlighted tail.</p>';
    const node = host.firstElementChild;

    const { hyperlights } = collectMarkAndCitePositions(node);

    const expectedLength = 'First sentence.121 Second sentence.122'.length;
    expect(hyperlights).toEqual(
      expect.arrayContaining([
        { highlightID: 'HL_508675734', charStart: 0, charEnd: expectedLength },
        { highlightID: 'HL_782669067', charStart: 0, charEnd: expectedLength },
      ])
    );
    expect(hyperlights).toHaveLength(2); // and crucially: no phantom HL_overlap
  });
});
