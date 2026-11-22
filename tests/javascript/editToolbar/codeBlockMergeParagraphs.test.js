/**
 * Selecting several paragraphs and pressing CODE makes ONE code block, not one
 * per paragraph. Python pasted as plain text arrives split at its blank lines
 * (smallPasteHandler splits on /\n\s*\n/), and the old 1:1 conversion chopped
 * it into separate cards, each with its own header.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleBlockquoteCodeFormat } from '../../../resources/js/editToolbar/blockFormat/blockquoteCodeFormat';

function build(innerHTML) {
  document.body.innerHTML = `<div contenteditable="true" class="main-content">${innerHTML}</div>`;
  return document.querySelector('.main-content');
}

function selectAcross(first, last) {
  const r = document.createRange();
  r.setStart(first.firstChild, 0);
  r.setEnd(last.lastChild, last.lastChild.textContent.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return sel;
}

function makeSelf(sel) {
  return {
    selectionManager: { currentSelection: sel },
    undoManager: { recordFormat: vi.fn() },
    currentBookId: 'book_mc',
    saveToIndexedDBCallback: vi.fn(async () => {}),
    deleteFromIndexedDBCallback: vi.fn(async () => {}),
    _mergeBlocksIntoBlockquote: vi.fn(),
    _contentPreservingWrap: vi.fn(),
  };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('multi-paragraph → code', () => {
  it('pasted chunks (multi-line paragraphs) merge into ONE block, blank line between', async () => {
    build(
      '<p id="100" data-node-id="book_mc_a">with open("myfile.txt", "w") as f:\n    f.write("First line.\\nSecond line.\\n")</p>' +
      '<p id="101" data-node-id="book_mc_b">print("Done writing file.")</p>' +
      '<p id="102">after</p>',
    );
    const sel = selectAcross(document.getElementById('100'), document.getElementById('101'));
    const self = makeSelf(sel);

    const { newElement } = await handleBlockquoteCodeFormat(self, 'code', true, document.getElementById('100'));

    const pres = document.querySelectorAll('pre');
    expect(pres.length).toBe(1);
    expect(newElement).toBe(pres[0]);
    expect(newElement.id).toBe('100');
    expect(newElement.getAttribute('data-node-id')).toBe('book_mc_a');
    expect(newElement.querySelector('code').textContent).toBe(
      'with open("myfile.txt", "w") as f:\n    f.write("First line.\\nSecond line.\\n")\n\nprint("Done writing file.")',
    );
    expect(document.getElementById('101')).toBeNull();
    expect(document.getElementById('102').textContent).toBe('after');
    expect(self.saveToIndexedDBCallback).toHaveBeenCalledWith('100', newElement.outerHTML);
    expect(self.deleteFromIndexedDBCallback).toHaveBeenCalledWith('101');
    expect(self.undoManager.recordFormat).toHaveBeenCalledTimes(1);
  });

  it('typed lines (one line per paragraph) join with a single newline', async () => {
    build('<p id="100">def f():</p><p id="101">    return 1</p><p id="102">f()</p>');
    const sel = selectAcross(document.getElementById('100'), document.getElementById('102'));
    const { newElement } = await handleBlockquoteCodeFormat(makeSelf(sel), 'code', true, document.getElementById('100'));
    expect(document.querySelectorAll('pre').length).toBe(1);
    expect(newElement.querySelector('code').textContent).toBe('def f():\n    return 1\nf()');
  });

  it('<br> line breaks become newline TEXT, and a highlight mark keeps its identity', async () => {
    build('<p id="100">a = 1<br>b = <mark id="HL_x">2</mark></p><p id="101">c = 3</p>');
    const mark = document.getElementById('HL_x');
    const sel = selectAcross(document.getElementById('100'), document.getElementById('101'));
    const { newElement } = await handleBlockquoteCodeFormat(makeSelf(sel), 'code', true, document.getElementById('100'));
    const code = newElement.querySelector('code');
    expect(code.querySelector('br')).toBeNull();
    expect(code.textContent).toBe('a = 1\nb = 2\n\nc = 3');
    expect(code.querySelector('#HL_x')).toBe(mark);
  });

  it('undo restores the original paragraphs; redo re-merges', async () => {
    build('<p id="100">x = 1</p><p id="101">y = 2</p>');
    const sel = selectAcross(document.getElementById('100'), document.getElementById('101'));
    const self = makeSelf(sel);
    await handleBlockquoteCodeFormat(self, 'code', true, document.getElementById('100'));
    const [, undo, redo] = self.undoManager.recordFormat.mock.calls[0];

    const restored = undo(document.getElementById('100'));
    expect(restored.tagName).toBe('P');
    expect(document.querySelectorAll('p').length).toBe(2);
    expect(document.querySelector('pre')).toBeNull();

    const redone = redo(document.getElementById('100'));
    expect(redone.tagName).toBe('PRE');
    expect(document.querySelectorAll('pre').length).toBe(1);
    expect(redone.textContent).toBe('x = 1\ny = 2');
  });
});
