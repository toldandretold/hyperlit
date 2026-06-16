/**
 * Characterization of hyperciteArrowHandler (divEditor/supTagHandler/arrowHandler.ts).
 * Arrow keys should skip the whole hypercite <a> anchor in one press.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hyperciteArrowHandler } from '../../../resources/js/divEditor/supTagHandler/arrowHandler';

let p, anchor;
beforeEach(() => {
  document.body.innerHTML = '';
  window.isEditing = true;
  p = document.createElement('p');
  p.innerHTML = 'hello<a href="/b#hypercite_x" class="open-icon">↗</a>world';
  anchor = p.querySelector('a');
  document.body.appendChild(p);
});

function cursorAt(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset); r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
}
const key = (k) => ({ key: k, preventDefault: vi.fn() });

describe('hyperciteArrowHandler', () => {
  it('ArrowRight from just before the anchor jumps the cursor to after it', () => {
    cursorAt(p.firstChild, 'hello'.length);   // end of "hello", anchor is next sibling
    const e = key('ArrowRight');
    hyperciteArrowHandler(e);
    expect(e.preventDefault).toHaveBeenCalled();
    const sel = window.getSelection();
    expect(sel.anchorNode).toBe(p);
    expect(sel.anchorOffset).toBe(2);          // past the anchor (index 1)
  });

  it('ArrowLeft from just after the anchor jumps the cursor to before it', () => {
    cursorAt(p.childNodes[2], 0);              // start of "world", anchor is prev sibling
    const e = key('ArrowLeft');
    hyperciteArrowHandler(e);
    expect(e.preventDefault).toHaveBeenCalled();
    const sel = window.getSelection();
    expect(sel.anchorNode).toBe(p);
    expect(sel.anchorOffset).toBe(1);          // before the anchor (index 1)
  });

  it('does nothing when not adjacent to a hypercite anchor', () => {
    cursorAt(p.firstChild, 2);                 // middle of "hello"
    const e = key('ArrowRight');
    hyperciteArrowHandler(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores non-arrow keys and when not editing', () => {
    cursorAt(p.firstChild, 'hello'.length);
    const e1 = key('a'); hyperciteArrowHandler(e1);
    expect(e1.preventDefault).not.toHaveBeenCalled();
    window.isEditing = false;
    const e2 = key('ArrowRight'); hyperciteArrowHandler(e2);
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });
});
