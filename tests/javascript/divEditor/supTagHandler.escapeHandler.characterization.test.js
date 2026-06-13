/**
 * Characterization of supEscapeHandler (divEditor/supTagHandler/escapeHandler.ts).
 * Typing inside/adjacent to a footnote <sup> or hypercite <a> must be redirected
 * to a text node OUTSIDE the element (cursor escapes), never editing the generated content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supEscapeHandler } from '../../../resources/js/divEditor/supTagHandler/escapeHandler.ts';

let p, sup;
beforeEach(() => {
  document.body.innerHTML = '';
  window.isEditing = true;
  p = document.createElement('p'); p.id = '1';
  p.innerHTML = 'hello<sup fn-count-id="1">2</sup>world';
  sup = p.querySelector('sup');
  document.body.appendChild(p);
});
function cursorAt(node, offset) {
  const r = document.createRange(); r.setStart(node, offset); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
const ev = (over) => ({ inputType: 'insertText', data: 'x', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over });

describe('supEscapeHandler', () => {
  it('typing at the END of a footnote sup inserts the text AFTER the sup', () => {
    cursorAt(sup.firstChild, 1);                 // end of "2"
    const e = ev();
    supEscapeHandler(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(sup.nextSibling.textContent).toBe('x');   // inserted after the sup
  });

  it('typing at the START of a footnote sup inserts the text BEFORE the sup', () => {
    cursorAt(sup.firstChild, 0);                 // start of "2"
    const e = ev();
    supEscapeHandler(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(sup.previousSibling.textContent).toBe('x');  // inserted before the sup
  });

  it('does nothing when typing in plain text away from a sup', () => {
    cursorAt(p.firstChild, 2);                   // middle of "hello"
    const e = ev();
    supEscapeHandler(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores non-insert input types and Enter/line breaks', () => {
    cursorAt(sup.firstChild, 1);
    const del = ev({ inputType: 'deleteContentBackward' });
    supEscapeHandler(del);
    expect(del.preventDefault).not.toHaveBeenCalled();

    const para = ev({ inputType: 'insertParagraph' });
    supEscapeHandler(para);
    expect(para.preventDefault).not.toHaveBeenCalled();
  });
});
