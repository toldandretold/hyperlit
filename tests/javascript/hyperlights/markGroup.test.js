/**
 * Mark-group hover/click feedback (hyperlights/markGroup).
 *
 * A hyperlight renders as MULTIPLE sibling <mark> elements — applyHighlights
 * splits it at overlap boundaries and around protected elements (footnote
 * <sup>s). CSS :hover only lights the fragment under the cursor, which made a
 * highlight look like "the region between two sup tags" instead of the real
 * highlighted text. The group helpers stamp every mark sharing the hovered/
 * clicked mark's HL_* classes so the visual feedback matches the highlight.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// listeners.js statically imports the container module, whose import chain
// doesn't load under happy-dom — same stubs as overlapClick.characterization.
vi.mock('../../../resources/js/hyperlitContainer/index', () => ({
  handleUnifiedContentClick: vi.fn().mockResolvedValue(undefined),
  initializeHyperlitManager: vi.fn(),
  openHyperlitContainer: vi.fn(),
  closeHyperlitContainer: vi.fn(),
}));
vi.mock('../../../resources/js/divEditor/index.js', () => ({
  queueNodeForSave: vi.fn(),
  startObserving: vi.fn(),
  isEditorObserving: vi.fn(() => false),
}));

import {
  GROUP_HOVER_CLASS,
  getHighlightIdsFromMark,
  getMarkGroup,
  applyGroupHover,
  clearGroupHover,
} from '../../../resources/js/hyperlights/markGroup';
import { handleMarkHover, handleMarkHoverOut } from '../../../resources/js/hyperlights/listeners';

/**
 * Production DOM shape: one passage covered by two co-extensive highlights,
 * split into a run of sibling marks by footnote sups — plus a separate,
 * unrelated highlight later in the node.
 */
function buildNode() {
  const host = document.createElement('div');
  host.innerHTML =
    '<p id="11300" data-node-id="book_x_y_z">' +
    '<mark id="HL_overlap" class="HL_1 HL_2">First sentence.</mark>' +
    '<mark id="HL_overlap" class="HL_1 HL_2"><sup id="Fn_a" fn-count-id="121" class="footnote-ref">121</sup></mark>' +
    '<mark id="HL_overlap" class="HL_1 HL_2"> Second sentence.</mark>' +
    'plain text between ' +
    '<mark id="HL_3" class="HL_3">another highlight</mark>' +
    '</p>';
  document.body.innerHTML = '';
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('getHighlightIdsFromMark', () => {
  it('returns the HL_* classes, ignoring styling classes and the synthetic HL_overlap', () => {
    const mark = document.createElement('mark');
    mark.className = 'HL_1 HL_2 HL_overlap user-highlight hl-plausible';
    expect(getHighlightIdsFromMark(mark)).toEqual(['HL_1', 'HL_2']);
  });
});

describe('getMarkGroup', () => {
  it('resolves a fragment to every mark sharing its highlight classes — not the whole node', () => {
    const host = buildNode();
    const marks = Array.from(host.querySelectorAll('mark'));
    const supFragment = marks[1]; // the mark wrapping only <sup>121</sup>

    const group = getMarkGroup(supFragment);

    expect(group).toEqual(marks.slice(0, 3)); // all 3 segments of HL_1/HL_2
    expect(group).not.toContain(marks[3]);    // the unrelated HL_3 mark stays out
  });

  it('returns an empty group for marks with no real highlight class', () => {
    const mark = document.createElement('mark');
    mark.className = 'highlight'; // ephemeral rangy class
    document.body.appendChild(mark);
    expect(getMarkGroup(mark)).toEqual([]);
  });
});

describe('hover handlers light up the whole highlight, not the fragment under the cursor', () => {
  it('mouseover on a sup fragment stamps the group class on all segments of that highlight', () => {
    const host = buildNode();
    const marks = Array.from(host.querySelectorAll('mark'));
    const sup = host.querySelector('sup');

    // Hovering the sup INSIDE the middle fragment (event.target is the sup)
    handleMarkHover({ target: sup });

    expect(marks[0].classList.contains(GROUP_HOVER_CLASS)).toBe(true);
    expect(marks[1].classList.contains(GROUP_HOVER_CLASS)).toBe(true);
    expect(marks[2].classList.contains(GROUP_HOVER_CLASS)).toBe(true);
    expect(marks[3].classList.contains(GROUP_HOVER_CLASS)).toBe(false); // unrelated highlight untouched
  });

  it('mouseout clears the group class everywhere', () => {
    const host = buildNode();
    const marks = Array.from(host.querySelectorAll('mark'));
    handleMarkHover({ target: marks[0] });
    expect(host.querySelectorAll(`.${GROUP_HOVER_CLASS}`).length).toBe(3);

    handleMarkHoverOut({ target: marks[0] });

    expect(host.querySelectorAll(`.${GROUP_HOVER_CLASS}`).length).toBe(0);
  });

  it('hovering the unrelated highlight lights only that highlight', () => {
    const host = buildNode();
    const marks = Array.from(host.querySelectorAll('mark'));

    handleMarkHover({ target: marks[3] });

    expect(marks[3].classList.contains(GROUP_HOVER_CLASS)).toBe(true);
    expect(host.querySelectorAll(`.${GROUP_HOVER_CLASS}`).length).toBe(1);
  });
});

describe('applyGroupHover / clearGroupHover primitives', () => {
  it('round-trips cleanly', () => {
    const host = buildNode();
    const marks = Array.from(host.querySelectorAll('mark'));

    applyGroupHover(marks[2]);
    expect(host.querySelectorAll(`.${GROUP_HOVER_CLASS}`).length).toBe(3);

    clearGroupHover();
    expect(host.querySelectorAll(`.${GROUP_HOVER_CLASS}`).length).toBe(0);
  });
});
