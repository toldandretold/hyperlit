/**
 * Characterization of fixInvalidMarks (createHighlight.ts) — the rangy-mess
 * cleanup: rangy can wrap block elements (<li>/<p>) inside a <mark>, which is
 * invalid; this rebuilds them into per-text-node marks and unwraps the block.
 *
 * The one genuinely gnarly pure-DOM algorithm pulled out of the old
 * selection.js monster; pinned as part of the decomposition.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// rangy is a <script> global; createHighlight.ts calls rangy.init() at module load.
vi.hoisted(() => {
  globalThis.rangy = {
    init: () => {},
    createHighlighter: () => ({ addClassApplier: () => {}, highlightSelection: () => {} }),
    createClassApplier: () => ({}),
  };
});
// Heavy reader chain that breaks under happy-dom (same stubs as overlapClick test).
vi.mock('../../../resources/js/hyperlitContainer/index.js', () => ({
  handleUnifiedContentClick: vi.fn(), initializeHyperlitManager: vi.fn(),
  openHyperlitContainer: vi.fn(), closeHyperlitContainer: vi.fn(),
}));
vi.mock('../../../resources/js/divEditor/index.js', () => ({
  queueNodeForSave: vi.fn(), queueForSave: vi.fn(), startObserving: vi.fn(), isEditorObserving: vi.fn(() => false),
}));

import { fixInvalidMarks } from '../../../resources/js/hyperlights/createHighlight';

beforeEach(() => { document.body.innerHTML = ''; });

describe('fixInvalidMarks', () => {
  it('unwraps a <mark> that wrongly wraps an <li>, re-marking the list item text', () => {
    document.body.innerHTML = '<ul><mark class="highlight"><li>item one</li></mark></ul>';

    fixInvalidMarks();

    const ul = document.querySelector('ul');
    // the block <li> is moved out of the mark...
    const li = ul.querySelector('li');
    expect(li).not.toBeNull();
    expect(li.parentElement.tagName).toBe('UL');
    // ...with its text re-wrapped in a highlight mark inside the li
    expect(li.querySelector('mark.highlight')?.textContent).toBe('item one');
    // and the original invalid (now-empty) mark is gone
    expect(ul.querySelector(':scope > mark')).toBeNull();
  });

  it('leaves a valid inline mark untouched', () => {
    document.body.innerHTML = '<p id="1">a <mark class="highlight">word</mark> b</p>';
    fixInvalidMarks();
    const mark = document.querySelector('p > mark.highlight');
    expect(mark?.textContent).toBe('word');
  });
});
