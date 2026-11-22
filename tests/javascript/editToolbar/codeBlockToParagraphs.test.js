/**
 * Code block → paragraphs (the P button on a code block). Selected lines
 * become one paragraph each; lines above stay in the block, lines below go to
 * a new code block with the same language. Uses the REAL id generator: new
 * nodes must sort where they sit (a node's id is its position).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installDecimalIdSelectorShim } from '../_helpers/decimalIdSelectorShim.js';

installDecimalIdSelectorShim();
vi.mock('../../../resources/js/app', () => ({ book: 'book_cp' }));

import { handleBlockquoteCodeFormat } from '../../../resources/js/editToolbar/blockFormat/blockquoteCodeFormat';

const CODE = 'def f():\n    a = 1\n    return a\n\nprint(f())';

function build() {
  document.body.innerHTML =
    '<div contenteditable="true" class="main-content" id="book_cp"><div class="chunk" data-chunk-id="0">' +
    '<p id="100" data-node-id="book_cp_a">before</p>' +
    `<pre id="200" data-node-id="book_cp_b"><code class="language-python">${CODE}</code></pre>` +
    '<p id="300" data-node-id="book_cp_c">after</p>' +
    '</div></div>';
  return document.querySelector('pre code');
}

function select(code, from, to) {
  const t = code.firstChild;
  const r = document.createRange();
  r.setStart(t, CODE.indexOf(from));
  r.setEnd(t, CODE.indexOf(to) + to.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return sel;
}

function makeSelf(sel) {
  return {
    selectionManager: { currentSelection: sel },
    undoManager: { recordFormat: vi.fn() },
    currentBookId: 'book_cp',
    saveToIndexedDBCallback: vi.fn(async () => {}),
    deleteFromIndexedDBCallback: vi.fn(async () => {}),
  };
}

const shape = () => Array.from(document.querySelector('.chunk').children).map((el) => ({
  tag: el.tagName, id: el.id, text: el.textContent.replace(/ /g, ' '), cls: el.querySelector('code')?.getAttribute('class') ?? null,
}));

function assertOrdered() {
  const ids = Array.from(document.querySelector('.chunk').children).map((el) => parseFloat(el.id));
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(ids.length);
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('code block → paragraphs', () => {
  it('a selection in the MIDDLE splits: code above, paragraphs, code below', async () => {
    const code = build();
    const sel = select(code, 'a = 1', 'return a');
    const self = makeSelf(sel);
    await handleBlockquoteCodeFormat(self, 'code', true, code);

    const s = shape();
    expect(s.map((x) => x.tag)).toEqual(['P', 'PRE', 'P', 'P', 'PRE', 'P']);
    expect(s[1]).toMatchObject({ id: '200', text: 'def f():', cls: 'language-python' });
    expect(s[2].text).toBe('    a = 1');
    expect(s[3].text).toBe('    return a');
    expect(s[4]).toMatchObject({ text: 'print(f())', cls: 'language-python' });
    assertOrdered();
    expect(self.saveToIndexedDBCallback).toHaveBeenCalledTimes(4);
  });

  it('a partial selection converts every line it TOUCHES', async () => {
    const code = build();
    const sel = select(code, 'f():', 'a =');
    await handleBlockquoteCodeFormat(makeSelf(sel), 'code', true, code);
    const s = shape();
    expect(s.map((x) => x.tag)).toEqual(['P', 'P', 'P', 'PRE', 'P']);
    expect(s[1]).toMatchObject({ id: '200', text: 'def f():' });
    expect(s[2].text).toBe('    a = 1');
    assertOrdered();
  });

  it('caret only: the whole block becomes one paragraph per non-blank line', async () => {
    const code = build();
    const r = document.createRange();
    r.setStart(code.firstChild, 2);
    r.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    await handleBlockquoteCodeFormat(makeSelf(window.getSelection()), 'code', false, code);
    const s = shape();
    expect(s.map((x) => x.tag)).toEqual(['P', 'P', 'P', 'P', 'P', 'P']);
    expect(s.slice(1, 5).map((x) => x.text)).toEqual(['def f():', '    a = 1', '    return a', 'print(f())']);
    expect(s[1].id).toBe('200');
    expect(document.querySelector('pre')).toBeNull();
    assertOrdered();
  });

  it('undo restores the original block exactly; redo re-applies with the same ids', async () => {
    const code = build();
    const original = document.querySelector('pre').outerHTML;
    const sel = select(code, 'a = 1', 'return a');
    const self = makeSelf(sel);
    await handleBlockquoteCodeFormat(self, 'code', true, code);
    const after = shape();
    const [recId, undo, redo] = self.undoManager.recordFormat.mock.calls[0];

    const restored = undo(document.getElementById(recId));
    expect(restored.outerHTML).toBe(original);
    expect(shape().map((x) => x.tag)).toEqual(['P', 'PRE', 'P']);

    redo(document.getElementById(recId));
    expect(shape()).toEqual(after);
  });

  it('a highlight <mark> and a hypercite <u> travel WITH their text into the new paragraph', async () => {
    document.body.innerHTML =
      '<div contenteditable="true" class="main-content" id="book_cp"><div class="chunk" data-chunk-id="0">' +
      '<p id="100">before</p>' +
      '<pre id="200" data-node-id="book_cp_b"><code class="language-python">def f():\n    <mark id="HL_1" class="HL_1">a = 1</mark>\n    return <u id="hypercite_x" class="couple">a</u>\nprint(f())</code></pre>' +
      '<p id="300">after</p></div></div>';
    const code = document.querySelector('pre code');
    const r = document.createRange();
    r.setStart(document.getElementById('HL_1').firstChild, 1);
    r.setEnd(document.getElementById('hypercite_x').firstChild, 1);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    await handleBlockquoteCodeFormat(makeSelf(window.getSelection()), 'code', true, code);

    const s = shape();
    expect(s.map((x) => x.tag)).toEqual(['P', 'PRE', 'P', 'P', 'PRE', 'P']);
    const [p1, p2] = Array.from(document.querySelectorAll('.chunk > p')).slice(1, 3);
    expect(p1.querySelector('mark#HL_1')?.textContent).toBe('a = 1');
    expect(p1.textContent.replace(/ /g, ' ')).toBe('    a = 1');
    expect(p2.querySelector('u#hypercite_x.couple')?.textContent).toBe('a');
    expect(p2.textContent.replace(/ /g, ' ')).toBe('    return a');
    // Nothing leaked into the code blocks, and no empty wrapper clones.
    expect(document.querySelectorAll('pre mark, pre u').length).toBe(0);
    // (happy-dom's :empty matches text-bearing elements, so check explicitly.)
    expect(Array.from(document.querySelectorAll('mark, u')).filter((e) => e.textContent === '').length).toBe(0);
    assertOrdered();
  });

  it('a mark spanning two converted lines lands in both paragraphs (same id, split like Enter)', async () => {
    document.body.innerHTML =
      '<div contenteditable="true" class="main-content" id="book_cp"><div class="chunk" data-chunk-id="0">' +
      '<pre id="200"><code>x = <mark id="HL_2" class="HL_2">1\ny</mark> = 2</code></pre></div></div>';
    const code = document.querySelector('pre code');
    const r = document.createRange();
    r.setStart(code.firstChild, 0);
    r.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    await handleBlockquoteCodeFormat(makeSelf(window.getSelection()), 'code', false, code);
    const ps = Array.from(document.querySelectorAll('.chunk > p'));
    expect(ps.map((p) => p.textContent)).toEqual(['x = 1', 'y = 2']);
    expect(ps[0].querySelector('mark.HL_2').textContent).toBe('1');
    expect(ps[1].querySelector('mark.HL_2').textContent).toBe('y');
  });
});
