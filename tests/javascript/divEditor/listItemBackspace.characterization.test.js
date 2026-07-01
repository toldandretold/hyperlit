/**
 * Characterization of handleListItemBackspace
 * (divEditor/keydownGuards/listItemBackspace.ts): Backspace at the start of a list item
 * either removes an empty bullet (caret → end of previous bullet) or outdents the item
 * to a paragraph across the four positional cases (empty-list replace / first / last /
 * middle-split). editorState + idHelpers + app are mocked; listItemCaret is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queueNodeForSave } = vi.hoisted(() => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/divEditor/editorState', () => ({
  queueNodeForSave, queueNodeForDeletion: vi.fn(),
}));
vi.mock('../../../resources/js/app', () => ({ book: 'testbook' }));
vi.mock('../../../resources/js/utilities/idHelpers', () => {
  let c = 0;
  return {
    ensureNodeHasValidId: (node) => { if (!node.id) node.id = `gen${++c}`; },
    setElementIds: (el) => { el.id = `p${++c}`; },
    findPreviousElementId: () => null,
    findNextElementId: () => null,
  };
});

import { handleListItemBackspace } from '../../../resources/js/divEditor/keydownGuards/listItemBackspace';

beforeEach(() => { document.body.innerHTML = ''; window.isEditing = true; vi.clearAllMocks(); });

const bsp = (over) => ({ key: 'Backspace', preventDefault: vi.fn(), ...over });

// Put a collapsed caret at the very start of an <li>'s first text node.
function caretAtStartOf(li) {
  const r = document.createRange();
  r.setStart(li.firstChild, 0);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return { range: r, selection: sel };
}

describe('handleListItemBackspace — early exits', () => {
  it('returns false when the key is not Backspace', () => {
    document.body.innerHTML = '<ul><li>a</li></ul>';
    const li = document.querySelector('li');
    const { range, selection } = caretAtStartOf(li);
    expect(handleListItemBackspace(bsp({ key: 'Delete' }), range, selection, li)).toBe(false);
  });

  it('returns false when there is no enclosing <li>', () => {
    document.body.innerHTML = '<p id="1">hello</p>';
    const p = document.querySelector('[id="1"]');
    const r = document.createRange(); r.setStart(p.firstChild, 0); r.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    expect(handleListItemBackspace(bsp(), r, sel, p)).toBe(false);
  });

  it('returns false when the caret is not at the start of the item', () => {
    document.body.innerHTML = '<ul><li>hello</li></ul>';
    const li = document.querySelector('li');
    const r = document.createRange(); r.setStart(li.firstChild, 3); r.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    expect(handleListItemBackspace(bsp(), r, sel, li)).toBe(false);
  });
});

describe('handleListItemBackspace — empty bullet with a previous bullet', () => {
  it('removes the empty bullet, keeps the list, and queues an update', () => {
    document.body.innerHTML = '<ul id="L"><li>first</li><li></li></ul>';
    const emptyLi = document.querySelectorAll('li')[1];
    // Empty <li> has no firstChild text node — caret sits on the li element itself.
    const r = document.createRange(); r.setStart(emptyLi, 0); r.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    const e = bsp();

    const result = handleListItemBackspace(e, r, sel, emptyLi);

    expect(result).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.querySelectorAll('li').length).toBe(1);        // empty bullet removed
    expect(queueNodeForSave).toHaveBeenCalledWith('L', 'update');
  });
});

describe('handleListItemBackspace — outdent to paragraph', () => {
  it('sole item: replaces the list with a paragraph (add)', () => {
    document.body.innerHTML = '<div class="main-content"><ul><li>solo</li></ul></div>';
    const li = document.querySelector('li');
    const { range, selection } = caretAtStartOf(li);
    const e = bsp();

    expect(handleListItemBackspace(e, range, selection, li)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.querySelector('ul')).toBeNull();               // list gone
    const p = document.querySelector('p');
    expect(p).not.toBeNull();
    expect(p.textContent).toBe('solo');
    expect(queueNodeForSave).toHaveBeenCalledWith(p.id, 'add');
  });

  it('first item: inserts a paragraph before the list', () => {
    document.body.innerHTML = '<div class="main-content"><ul><li>one</li><li>two</li></ul></div>';
    const li = document.querySelectorAll('li')[0];
    const { range, selection } = caretAtStartOf(li);

    expect(handleListItemBackspace(bsp(), range, selection, li)).toBe(true);
    const p = document.querySelector('p');
    expect(p.textContent).toBe('one');
    expect(p.nextElementSibling.tagName).toBe('UL');               // paragraph before the list
    expect(document.querySelectorAll('li').length).toBe(1);
  });

  it('middle item: splits the list around the new paragraph', () => {
    document.body.innerHTML = '<div class="main-content"><ul><li>a</li><li>b</li><li>c</li></ul></div>';
    const li = document.querySelectorAll('li')[1];
    const { range, selection } = caretAtStartOf(li);

    expect(handleListItemBackspace(bsp(), range, selection, li)).toBe(true);
    const p = document.querySelector('p');
    expect(p.textContent).toBe('b');
    expect(document.querySelectorAll('ul').length).toBe(2);        // list split in two
    // Three saves: original list update, new paragraph add, new list add.
    expect(queueNodeForSave).toHaveBeenCalledTimes(3);
  });
});
