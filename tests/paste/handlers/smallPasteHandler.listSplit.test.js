/**
 * @vitest-environment jsdom
 *
 * MUST run under jsdom: the whole bug class here is an HTML *parser* rule that
 * happy-dom does not implement — a "li" start tag CLOSES an open <p>. jsdom (like
 * every real browser) does implement it, so a re-parse assertion actually bites.
 *
 * DATA-LOSS REGRESSION — pasting into a bullet list produced `<p><li>…</li></p>`.
 * ==============================================================================
 * _blockPaste splits the node at the cursor and re-homes the half after the cursor
 * (the "tail") into a NEW element. That element used to be a hardcoded <p>. When
 * the node being split is a <ul>, Range.extractContents() hands back a run of <li>
 * elements — so the tail became `<p><li>rest of item</li><li>next item</li></p>`.
 *
 * The live DOM keeps that (DOM manipulation never re-parses), so it saves to
 * IndexedDB looking fine. Every LATER re-parse — page reload, DOMPurify, the
 * integrity verifier's DOMParser read-back — closes the <p> at the first <li> and
 * the node collapses to an EMPTY <p>. Prod report book_1787277324949 (2026-08-21):
 * "DOM 49 chars, IDB 0 chars" on `<p id="191.1"><li></li><li>equipped with an
 * in-text open weight AI Archivist</li></p>`.
 *
 * Fix: the tail element mirrors the split node's tag (a <ul> tail is a <ul>), and
 * orphan <li>s in the clipboard get a real list parent before insertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the heavy editor / data-layer barrels. sanitizeHtml + blockElements stay REAL.
vi.mock('../../../resources/js/divEditor/index', () => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/editToolbar/index', () => ({ getEditToolbar: () => undefined }));
vi.mock('../../../resources/js/editToolbar/toolbarDOMUtils', () => ({
  getTextOffsetInElement: vi.fn(() => 0),
  setCursorAtTextOffset: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setProgrammaticUpdateInProgress: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/IDfunctions', () => {
  let seq = 0;
  return {
    // Enough of the real contract for the handler: a valid decimal id + a node_id.
    setElementIds: (element, lastKnownId) => {
      seq += 1;
      element.id = `${lastKnownId.split('.')[0]}.${seq}`;
      element.setAttribute('data-node-id', `book_test_${seq}`);
    },
    compareDecimalStrings: (a, b) => parseFloat(a) - parseFloat(b),
    isDuplicateId: (id) => document.querySelectorAll(`[id="${id}"]`).length > 1,
  };
});

const { handleSmallPaste } = await import('../../../resources/js/paste/handlers/smallPasteHandler');

/**
 * The integrity verifier's read-back (resources/js/integrity/verifier.ts
 * textFromStoredHTML): stored content is re-parsed and the FIRST element's text
 * is compared against the live DOM. This is the step that reported 0 chars.
 */
function textAfterReparse(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.body.firstElementChild || doc.body;
  return el.textContent.trim();
}

function buildBook(innerHTML) {
  document.body.innerHTML = `
    <div class="main-content" id="book_test" data-book-id="book_test" contenteditable="true">
      <div class="chunk" data-chunk-id="0">${innerHTML}</div>
    </div>`;
  return document.querySelector('.chunk');
}

/** Put the caret inside `textNode` at `offset` and fire the paste. */
function pasteAt(textNode, offset, clipboardHtml) {
  const range = document.createRange();
  range.setStart(textNode, offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const event = { preventDefault: vi.fn() };
  const handled = handleSmallPaste(event, clipboardHtml, '', 1, 'book_test');
  expect(handled).toBe(true);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('_blockPaste — splitting a list node', () => {
  it('gives the tail the same tag as the split node (<ul>, not <p>)', () => {
    const chunk = buildBook(
      '<ul id="190" data-node-id="book_test_orig"><li>alpha</li><li>equipped with an in-text</li></ul>'
    );
    const firstItemText = chunk.querySelector('li').firstChild;

    pasteAt(firstItemText, 5, '<ul><li>pasted bullet</li></ul>');

    // The split node keeps its head, the pasted list lands next, and the TAIL is a <ul>
    const blocks = Array.from(chunk.children);
    expect(blocks.map((el) => el.tagName)).toEqual(['UL', 'UL', 'UL']);

    const tail = blocks[2];
    expect(tail.textContent).toContain('equipped with an in-text');
    // The caret sat at the end of "alpha", so the tail must NOT open with the
    // empty <li> the extraction produced (the stray bullet in the prod report).
    expect(tail.firstElementChild.textContent.trim()).not.toBe('');
  });

  it('never emits a <p> holding <li> children', () => {
    const chunk = buildBook(
      '<ul id="190" data-node-id="book_test_orig"><li>alpha</li><li>beta</li><li>gamma</li></ul>'
    );
    pasteAt(chunk.querySelector('li').firstChild, 5, '<ul><li>pasted</li></ul>');

    expect(document.querySelectorAll('p > li')).toHaveLength(0);
  });

  it('keeps the tail text alive through a re-parse (the integrity read-back)', () => {
    const chunk = buildBook(
      '<ul id="190" data-node-id="book_test_orig"><li>alpha</li><li>equipped with an in-text</li></ul>'
    );
    pasteAt(chunk.querySelector('li').firstChild, 5, '<ul><li>pasted</li></ul>');

    const tail = chunk.lastElementChild;
    // This is the exact comparison that reported "DOM 49 chars, IDB 0 chars".
    expect(textAfterReparse(tail.outerHTML)).toBe(tail.textContent.trim());
    expect(textAfterReparse(tail.outerHTML)).toContain('equipped with an in-text');
  });

  it('leaves a list emptied by the split with a real <li>, not a bare <br>', () => {
    const chunk = buildBook('<ul id="190" data-node-id="book_test_orig"><li>alpha</li></ul>');
    // Caret at the very start: the whole list becomes tail, the head is emptied.
    pasteAt(chunk.querySelector('li').firstChild, 0, '<ul><li>pasted</li></ul>');

    const head = chunk.firstElementChild;
    expect(head.id).toBe('190');
    expect(head.querySelector(':scope > br')).toBeNull();
    if (!head.textContent.trim()) {
      expect(head.querySelector('li')).not.toBeNull();
    }
  });

  it('splits a <blockquote> into a <blockquote>, not a <p>', () => {
    const chunk = buildBook(
      '<blockquote id="190" data-node-id="book_test_orig">alpha omega</blockquote>'
    );
    pasteAt(chunk.querySelector('blockquote').firstChild, 5, '<ul><li>pasted</li></ul>');

    const tail = chunk.lastElementChild;
    expect(tail.tagName).toBe('BLOCKQUOTE');
    expect(textAfterReparse(tail.outerHTML)).toContain('omega');
  });

  it('still uses a <p> for a heading tail (no duplicate heading in the book)', () => {
    const chunk = buildBook('<h2 id="190" data-node-id="book_test_orig">alpha omega</h2>');
    pasteAt(chunk.querySelector('h2').firstChild, 5, '<ul><li>pasted</li></ul>');

    const tail = chunk.lastElementChild;
    expect(tail.tagName).toBe('P');
    expect(tail.textContent).toContain('omega');
  });
});

describe('clipboard normalisation — orphan <li>', () => {
  it('wraps bare <li> clipboard content in a list instead of inlining it into the <p>', () => {
    const chunk = buildBook('<p id="190" data-node-id="book_test_orig">alpha omega</p>');
    pasteAt(chunk.querySelector('p').firstChild, 5, '<li>orphan one</li><li>orphan two</li>');

    expect(document.querySelectorAll('p > li')).toHaveLength(0);

    const list = chunk.querySelector('ul');
    expect(list).not.toBeNull();
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(textAfterReparse(list.outerHTML)).toContain('orphan two');
  });
});
