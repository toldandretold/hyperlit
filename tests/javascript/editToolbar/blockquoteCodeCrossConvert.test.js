/**
 * code ↔ blockquote CROSS-CONVERSION must transform content, never nest.
 * Regression for: pressing blockquote on a code block produced
 * `<blockquote><code>…<br></code><br></blockquote>` — the <code> element was
 * MOVED INTO the blockquote by the wrap path, rendering as an inline code
 * pill inside the quote. The fix adds an explicit transform branch (lines ↔
 * <br>s) with verbatim-restore undo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleBlockquoteCodeFormat } from '../../../resources/js/editToolbar/blockFormat/blockquoteCodeFormat';

function makeSelf() {
  return {
    selectionManager: {
      currentSelection: { focusNode: null, focusOffset: 0 },
      getWorkingSelection: () => ({ selection: null, range: null }),
    },
    undoManager: { recordFormat: vi.fn() },
    currentBookId: 'book_cc',
    unwrapBlock: vi.fn(),
    wrapBlock: vi.fn(),
  };
}

function buildEditable(innerHTML) {
  document.body.innerHTML = `<div contenteditable="true" class="main-content">${innerHTML}</div>`;
  return document.querySelector('.main-content');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('code → blockquote', () => {
  it('transforms lines to <br>s — never nests the <code> element (the corruption bug)', async () => {
    buildEditable('<pre id="196" data-node-id="book_cc_1_n"><code>line one\nline two</code></pre>');
    const self = makeSelf();
    const codeEl = document.getElementById('196').querySelector('code');

    const { newElement } = await handleBlockquoteCodeFormat(self, 'blockquote', false, codeEl);

    expect(newElement.tagName).toBe('BLOCKQUOTE');
    expect(newElement.querySelector('code'), 'no <code> may survive inside the blockquote').toBeNull();
    expect(newElement.innerHTML).toBe('line one<br>line two<br>');
    expect(newElement.id).toBe('196');
    expect(newElement.getAttribute('data-node-id')).toBe('book_cc_1_n');
    expect(self.wrapBlock).not.toHaveBeenCalled();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('escapes markup-looking code text', async () => {
    buildEditable('<pre id="200"><code>&lt;div&gt;hi&lt;/div&gt;</code></pre>');
    const self = makeSelf();
    const codeEl = document.getElementById('200').querySelector('code');

    const { newElement } = await handleBlockquoteCodeFormat(self, 'blockquote', false, codeEl);

    expect(newElement.textContent).toContain('<div>hi</div>');
    expect(newElement.querySelector('div')).toBeNull(); // not parsed as markup
  });
});

describe('blockquote → code', () => {
  it('joins <br>-separated lines into newline code text — no <br> inside <code>', async () => {
    buildEditable('<blockquote id="300" data-node-id="book_cc_2_n">alpha<br>beta<br></blockquote>');
    const self = makeSelf();
    const bq = document.getElementById('300');

    const { newElement } = await handleBlockquoteCodeFormat(self, 'code', false, bq);

    expect(newElement.tagName).toBe('PRE');
    const code = newElement.querySelector('code');
    expect(code.textContent).toBe('alpha\nbeta');
    expect(code.querySelector('br')).toBeNull();
    expect(newElement.id).toBe('300');
    expect(self.wrapBlock).not.toHaveBeenCalled();
  });
});

describe('undo round-trip', () => {
  it('undo restores the ORIGINAL pre verbatim; redo re-converts', async () => {
    buildEditable('<pre id="400" data-node-id="book_cc_3_n"><code>only line</code></pre>');
    const self = makeSelf();
    const codeEl = document.getElementById('400').querySelector('code');

    const { newElement } = await handleBlockquoteCodeFormat(self, 'blockquote', false, codeEl);

    expect(self.undoManager.recordFormat).toHaveBeenCalledTimes(1);
    const [elementId, undoFn, redoFn, bookId] = self.undoManager.recordFormat.mock.calls[0];
    expect(elementId).toBe('400');
    expect(bookId).toBe('book_cc');

    const restored = undoFn(newElement);
    expect(restored.tagName).toBe('PRE');
    expect(restored.querySelector('code').textContent).toBe('only line');
    expect(restored.id).toBe('400');

    const redone = redoFn(restored);
    expect(redone.tagName).toBe('BLOCKQUOTE');
    expect(redone.innerHTML).toBe('only line<br>');
    expect(redone.querySelector('code')).toBeNull();
  });
});
