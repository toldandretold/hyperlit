/**
 * Characterization of the meaningful caret helpers in
 * divEditor/enterKeyHandler/caretHelpers.ts: createAndInsertParagraph + moveCaretTo.
 * (scrollCaretIntoView/isElementInViewport are scroll/viewport plumbing → e2e.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queueNodeForSave } = vi.hoisted(() => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/app.js', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
vi.mock('../../../resources/js/utilities/IDfunctions', () => ({
  ensureNodeHasValidId: (el) => { if (!el.id) el.id = 'gen'; },
  setElementIds: (el, before) => { el.id = before ? `${before}.1` : '1'; el.setAttribute('data-node-id', `N${el.id}`); },
  triggerRenumberingWithModal: vi.fn(),
}));

import { createAndInsertParagraph, moveCaretTo } from '../../../resources/js/divEditor/enterKeyHandler/caretHelpers';

beforeEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

describe('createAndInsertParagraph', () => {
  it('inserts a new <p> after the block, assigns an id, and queues it for save', () => {
    const chunk = document.createElement('div'); chunk.className = 'chunk';
    const p1 = document.createElement('p'); p1.id = '1'; p1.textContent = 'one';
    chunk.appendChild(p1); document.body.appendChild(chunk);

    const newP = createAndInsertParagraph(p1, chunk, null, null);

    expect(newP).not.toBeNull();
    expect(newP.id).toBe('1.1');                      // setElementIds(before='1') → '1.1'
    expect(newP.previousElementSibling).toBe(p1);     // inserted right after p1
    expect(newP.querySelector('br')).not.toBeNull();  // empty content → <br>
    expect(queueNodeForSave).toHaveBeenCalledWith('1.1', 'add');
  });
});

describe('moveCaretTo', () => {
  it('collapses the selection at (node, offset)', () => {
    const p = document.createElement('p'); p.textContent = 'hello'; document.body.appendChild(p);
    moveCaretTo(p.firstChild, 2);
    const sel = window.getSelection();
    expect(sel.anchorNode).toBe(p.firstChild);
    expect(sel.anchorOffset).toBe(2);
    expect(sel.isCollapsed).toBe(true);
  });
});
