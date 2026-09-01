/**
 * @vitest-environment jsdom
 *
 * MUST run under jsdom: the assertions re-parse the created element's outerHTML,
 * relying on the HTML parser rule happy-dom does not implement — a block start
 * tag (ul/ol/table/li/…) CLOSES an open <p>.
 *
 * DATA-LOSS GUARD — Enter-key split must never build `<p><ul>…</ul></p>`.
 * =======================================================================
 * createAndInsertParagraph moves the extracted after-cursor fragment into a new
 * element. That element used to be a hardcoded <p>; when the fragment carried a
 * block node (splitting a <div>, or a source that already held a list), the
 * result was a <p> wrapping block content — alive in the DOM, saved to
 * IndexedDB looking fine, then EMPTY on every later re-parse (reload, DOMPurify,
 * the integrity verifier's DOMParser read-back). Prod report book_1788217034868
 * (2026-08-31): "DOM 36 chars, IDB 0 chars" on
 * `<p id="1400"><ul><li>Search Google Scholar…</ul></p>`.
 *
 * Fix: when the fragment contains a block-level (or <li>) node, the new element
 * is a <div> — a legal container for anything — instead of a <p>.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queueNodeForSave } = vi.hoisted(() => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/app.js', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ queueNodeForSave }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  ensureNodeHasValidId: (el) => { if (!el.id) el.id = 'gen'; },
  setElementIds: (el, before) => { el.id = before ? `${before}.1` : '1'; el.setAttribute('data-node-id', `N${el.id}`); },
}));
vi.mock('../../../resources/js/utilities/IDfunctions', () => ({
  triggerRenumberingWithModal: vi.fn(),
}));

import { createAndInsertParagraph } from '../../../resources/js/divEditor/enterKeyHandler/caretHelpers';

// jsdom implements Range but not Range.getBoundingClientRect (every real
// browser has it). moveCaretTo's 50ms settle timer calls scrollCaretIntoView,
// which reads it — without this stub that deferred call crashes the run as an
// uncaught exception after the assertions have already passed.
Range.prototype.getBoundingClientRect ??= () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
});

/** The integrity verifier's read-back: what a stored string keeps after a parse. */
function textAfterReparse(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.body.firstElementChild || doc.body;
  return el.textContent.trim();
}

function buildBlock() {
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  const p1 = document.createElement('p');
  p1.id = '1';
  p1.textContent = 'one';
  chunk.appendChild(p1);
  document.body.appendChild(chunk);
  return { chunk, p1 };
}

beforeEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

describe('createAndInsertParagraph — block content in the extracted fragment', () => {
  it('still creates a <p> for inline-only content', () => {
    const { chunk, p1 } = buildBlock();
    const content = document.createDocumentFragment();
    const em = document.createElement('em');
    em.textContent = 'tail text';
    content.appendChild(em);

    const created = createAndInsertParagraph(p1, chunk, content, null);

    expect(created.tagName).toBe('P');
    expect(created.textContent).toBe('tail text');
  });

  it('creates a <div> (not a <p>) when the fragment carries a <ul>', () => {
    const { chunk, p1 } = buildBlock();
    const content = document.createDocumentFragment();
    const ul = document.createElement('ul');
    ul.innerHTML = '<li><a href="#x">Search Google Scholar</a></li><li>Export Citation</li>';
    content.appendChild(ul);

    const created = createAndInsertParagraph(p1, chunk, content, null);

    expect(created.tagName).toBe('DIV');
    expect(created.previousElementSibling).toBe(p1);
    expect(created.id).toBe('1.1');
    expect(created.getAttribute('data-node-id')).toBe('N1.1');
    expect(queueNodeForSave).toHaveBeenCalledWith('1.1', 'add');
  });

  it('the created element survives the integrity read-back (the exact prod comparison)', () => {
    const { chunk, p1 } = buildBlock();
    const content = document.createDocumentFragment();
    const ul = document.createElement('ul');
    ul.innerHTML = '<li>Search Google Scholar</li><li>Export Citation</li>';
    content.appendChild(ul);

    const created = createAndInsertParagraph(p1, chunk, content, null);

    // This is the comparison that reported "DOM 36 chars, IDB 0 chars".
    expect(textAfterReparse(created.outerHTML)).toBe(created.textContent.trim());
    expect(textAfterReparse(created.outerHTML)).toContain('Search Google Scholar');
  });

  it('guards mixed fragments (text + block) and bare <li>s too', () => {
    const { chunk, p1 } = buildBlock();
    const content = document.createDocumentFragment();
    content.appendChild(document.createTextNode('leading '));
    const li = document.createElement('li');
    li.textContent = 'orphan item';
    content.appendChild(li);

    const created = createAndInsertParagraph(p1, chunk, content, null);

    expect(created.tagName).toBe('DIV');
    expect(textAfterReparse(created.outerHTML)).toContain('orphan item');
  });

  it('still unwraps a nested <p> from the fragment without triggering the <div> path', () => {
    const { chunk, p1 } = buildBlock();
    const content = document.createDocumentFragment();
    const innerP = document.createElement('p');
    innerP.innerHTML = 'from a <strong>partial</strong> paragraph';
    content.appendChild(innerP);

    const created = createAndInsertParagraph(p1, chunk, content, null);

    expect(created.tagName).toBe('P');
    expect(created.querySelector('p')).toBeNull();
    expect(created.textContent).toBe('from a partial paragraph');
  });
});
