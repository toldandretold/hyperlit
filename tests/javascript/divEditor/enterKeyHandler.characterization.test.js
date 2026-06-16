/**
 * Characterization of EnterKeyHandler.handleKeyDown — pins the current behaviour
 * of the (still whole) method BEFORE it's split into per-section private methods,
 * so the refactor can be proven behaviour-preserving (same tests, before & after).
 *
 * Imported extensionless so this file resolves to enterKeyHandler.js now and
 * enterKeyHandler/index.ts after the split — identical test, both sides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queueNodeForSave } = vi.hoisted(() => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/app.js', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
vi.mock('../../../resources/js/utilities/operationState', () => ({ chunkOverflowInProgress: false }));
// Pure ID helpers moved to utilities/idHelpers; triggerRenumberingWithModal stays in IDfunctions.
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  generateIdBetween: () => '1.5',
  setElementIds: (el, before) => { el.id = before ? `${before}.1` : '1'; el.setAttribute('data-node-id', `N${el.id}`); },
  ensureNodeHasValidId: (el) => { if (!el.id) el.id = 'gen'; },
  findPreviousElementId: () => null,
  findNextElementId: () => null,
}));
vi.mock('../../../resources/js/utilities/IDfunctions', () => ({
  triggerRenumberingWithModal: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/listItemCaret', () => ({
  listItemIsEmpty: (li) => !li.textContent.trim(),
  placeCaretInEmptyListItem: vi.fn(),
}));

import { EnterKeyHandler } from '../../../resources/js/divEditor/enterKeyHandler/index';

let handler;
beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  window.isEditing = true;            // handleKeyDown gates its whole body on this
  handler = new EnterKeyHandler();
});

function setMainContent(html) {
  const mc = document.createElement('div');
  mc.className = 'main-content';
  mc.innerHTML = html;
  document.body.appendChild(mc);
  return mc;
}
function cursorAt(node, offset) {
  const r = document.createRange(); r.setStart(node, offset); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
const enter = (over) => ({ key: 'Enter', shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over });

describe('handleKeyDown — guards', () => {
  it('ignores non-Enter keys', () => {
    const mc = setMainContent('<div class="chunk"><p id="1">hi</p></div>');
    cursorAt(mc.querySelector('p').firstChild, 2);
    const e = { key: 'a', preventDefault: vi.fn() };
    handler.handleKeyDown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(queueNodeForSave).not.toHaveBeenCalled();
  });
});

describe('handleKeyDown — paragraph (SECTION 1)', () => {
  it('regular Enter at end of a paragraph creates a new paragraph after it', () => {
    const mc = setMainContent('<div class="chunk"><p id="1">hello</p></div>');
    const p1 = mc.querySelector('p');
    cursorAt(p1.firstChild, 5);                 // end of "hello"
    handler.handleKeyDown(enter());

    const ps = mc.querySelectorAll('p');
    expect(ps.length).toBe(2);                  // a new paragraph was inserted
    expect(ps[0]).toBe(p1);
    expect(queueNodeForSave).toHaveBeenCalledWith(expect.any(String), 'add');
  });

  it('Shift+Enter inserts a <br> WITHOUT creating a new paragraph', () => {
    const mc = setMainContent('<div class="chunk"><p id="1">hello</p></div>');
    const p1 = mc.querySelector('p');
    cursorAt(p1.firstChild, 5);
    handler.handleKeyDown(enter({ shiftKey: true }));

    expect(mc.querySelectorAll('p').length).toBe(1);   // no new paragraph
    expect(p1.querySelector('br')).not.toBeNull();      // line break inserted
  });
});

describe('handleKeyDown — empty list item (SECTION 2.5)', () => {
  it('Enter in an empty <li> exits the list (no longer an empty li in the list)', () => {
    const mc = setMainContent('<div class="chunk"><ul id="5"><li><br></li></ul></div>');
    const li = mc.querySelector('li');
    cursorAt(li, 0);
    handler.handleKeyDown(enter());
    // exited: the empty li is gone from the list (behaviour pinned, exact target asserted loosely)
    expect(mc.querySelector('ul li')).toBeNull();
  });
});

describe('handleKeyDown — non-empty list item (SECTION 2.5)', () => {
  it('Enter at end of a non-empty <li> creates a new <li> and queues the list for save', () => {
    const mc = setMainContent('<div class="chunk"><ul id="5"><li id="x">item</li></ul></div>');
    const li = mc.querySelector('li');
    cursorAt(li.firstChild, 4);                  // end of "item"
    handler.handleKeyDown(enter());
    expect(mc.querySelectorAll('ul li').length).toBe(2);   // new li added
    expect(queueNodeForSave).toHaveBeenCalledWith('5', 'update');
  });
});

describe('handleKeyDown — blockquote (SECTION 2)', () => {
  it('first Enter in a blockquote inserts a <br>, does not exit the block', () => {
    const mc = setMainContent('<div class="chunk"><blockquote id="3">quote</blockquote></div>');
    const bq = mc.querySelector('blockquote');
    cursorAt(bq.firstChild, 5);                  // end of "quote"
    handler.handleKeyDown(enter());
    expect(mc.querySelectorAll('blockquote').length).toBe(1);  // still one block
    expect(bq.querySelector('br')).not.toBeNull();             // line break inserted
  });
});

describe('handleKeyDown — heading at start (escape)', () => {
  it('Enter at the very start of a heading inserts a paragraph before it', () => {
    const mc = setMainContent('<div class="chunk"><h2 id="1">Title</h2></div>');
    const h2 = mc.querySelector('h2');
    cursorAt(h2.firstChild, 0);                   // very start of the heading
    handler.handleKeyDown(enter());
    expect(h2.previousElementSibling).not.toBeNull();
    expect(h2.previousElementSibling.tagName).toBe('P');   // <p> inserted before heading
    expect(mc.querySelector('h2')).toBe(h2);               // heading itself survives
  });
});
