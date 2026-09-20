/**
 * DOM order MUST equal LineId order — the list-escape paths.
 *
 * A node's `id` (LineId / `NodeRecord.startLine`) is not a label, it is the book's
 * ORDER: `getAllNodesForBook` sorts by `startLine` and `getNodesFromIndexedDB` feeds the
 * renderer in that order, so a node handed an id that doesn't sort where it sits in the
 * DOM is silently relocated on the next render — and the audiobook manifest, which walks
 * the same records, reads it out in the wrong place.
 *
 * Nothing catches that after the fact. `integrity/verifier.ts` compares each node's DOM
 * text against the IDB record with the SAME id (mismatches / missingFromIDB / duplicateIds)
 * — in a reorder every node still matches its own record perfectly, so the verifier is
 * silent by construction. The id has to be right when it is minted; this is the gate.
 *
 * The escape-from-a-list paths were the hole (prod, 2026-09-18): splitting a list from the
 * MIDDLE passed `afterId = null` to `setElementIds`, and "no afterId" means "append at the
 * end" — `generateIdBetween` returns `floor(before) + 100`, jumping the new paragraph ~100
 * nodes past where it actually sits. The split-off list then went further still, because
 * `generateIdBetween` saw before ≥ after and fell back to the same +100 rule.
 *
 * These tests run the REAL idHelpers (mocking the generator is exactly what hid this)
 * across every positional case of every list-escape path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installDecimalIdSelectorShim } from '../_helpers/decimalIdSelectorShim.js';

// Let the real generateIdBetween / isIdInUse run under happy-dom (see the shim header).
installDecimalIdSelectorShim();

const { queueNodeForSave } = vi.hoisted(() => ({ queueNodeForSave: vi.fn() }));
vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/divEditor/editorState', () => ({
  queueNodeForSave, queueNodeForDeletion: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
vi.mock('../../../resources/js/utilities/operationState', () => ({ chunkOverflowInProgress: false }));
vi.mock('../../../resources/js/utilities/IDfunctions', () => ({ triggerRenumberingWithModal: vi.fn() }));

import { EnterKeyHandler } from '../../../resources/js/divEditor/enterKeyHandler/index';
import { handleListItemBackspace } from '../../../resources/js/divEditor/keydownGuards/listItemBackspace';
import { ListConverter } from '../../../resources/js/editToolbar/listConverter';

/**
 * Build a chunk of numerically-identified nodes. `listHtml` is spliced in as the node
 * carrying id `20`, between paragraphs `10` and `30` — so a correctly-minted id for
 * anything the list emits must land strictly between 20 and 30.
 */
function buildBook(listHtml, { before = '10', after = '30' } = {}) {
  document.body.innerHTML = '';
  const mc = document.createElement('div');
  mc.className = 'main-content';
  mc.innerHTML = `
    <div class="chunk" data-chunk-id="1" contenteditable="true">
      <p id="${before}">before</p>
      ${listHtml}
      <p id="${after}">after</p>
    </div>`;
  document.body.appendChild(mc);
  return mc;
}

/** Numeric-id block nodes in DOM order, as [id, ...]. */
function domIds(mc) {
  return Array.from(mc.querySelectorAll('.chunk > [id]'))
    .map((el) => el.id)
    .filter((id) => /^\d+(\.\d+)?$/.test(id));
}

/**
 * The invariant: reading the chunk top-to-bottom must give ascending LineIds, because
 * that is the order the renderer and the audiobook manifest will rebuild it in.
 */
function expectDomOrderMatchesIdOrder(mc) {
  const ids = domIds(mc);
  const sorted = [...ids].sort((a, b) => parseFloat(a) - parseFloat(b));
  expect(ids).toEqual(sorted);
  expect(new Set(ids).size).toBe(ids.length); // and no id minted twice
}

function cursorAt(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return { range: r, selection: sel };
}

const enter = (over) => ({
  key: 'Enter', shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over,
});
const backspace = (over) => ({ key: 'Backspace', preventDefault: vi.fn(), ...over });

let handler;
beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  window.isEditing = true;
  delete window.__pendingRenumbering;
  handler = new EnterKeyHandler();
});

describe('Enter in an empty <li> — the new paragraph sorts where it sits', () => {
  it('FIRST item: paragraph goes before the list and sorts before it', () => {
    const mc = buildBook('<ol id="20"><li><br></li><li>b</li><li>c</li></ol>');
    cursorAt(mc.querySelector('li'), 0);
    handler.handleKeyDown(enter());
    expectDomOrderMatchesIdOrder(mc);
  });

  it('LAST item: paragraph goes after the list and sorts after it', () => {
    const mc = buildBook('<ol id="20"><li>a</li><li>b</li><li><br></li></ol>');
    cursorAt(mc.querySelectorAll('li')[2], 0);
    handler.handleKeyDown(enter());
    expectDomOrderMatchesIdOrder(mc);
  });

  it('MIDDLE item: the paragraph AND the split-off list both stay between their neighbours', () => {
    const mc = buildBook('<ol id="20"><li>a</li><li><br></li><li>c</li></ol>');
    cursorAt(mc.querySelectorAll('li')[1], 0);
    handler.handleKeyDown(enter());

    // The split really happened: original list, escaped paragraph, remainder list.
    expect(mc.querySelectorAll('.chunk > ol').length).toBe(2);
    const ids = domIds(mc);
    expect(ids[0]).toBe('10');
    expect(ids[ids.length - 1]).toBe('30');
    // Every minted id belongs in the 20→30 gap, not 100 nodes downstream.
    for (const id of ids.slice(1, -1)) {
      expect(parseFloat(id)).toBeGreaterThanOrEqual(20);
      expect(parseFloat(id)).toBeLessThan(30);
    }
    expectDomOrderMatchesIdOrder(mc);
  });

  it('ONLY item: the list is replaced in place', () => {
    const mc = buildBook('<ol id="20"><li><br></li></ol>');
    cursorAt(mc.querySelector('li'), 0);
    handler.handleKeyDown(enter());
    expectDomOrderMatchesIdOrder(mc);
  });
});

describe('Backspace at the start of an <li> — same invariant', () => {
  const outdent = (mc, liIndex) => {
    const li = mc.querySelectorAll('li')[liIndex];
    const { range, selection } = cursorAt(li.firstChild, 0);
    handleListItemBackspace(backspace(), range, selection, li);
  };

  it('FIRST item outdents before the list', () => {
    const mc = buildBook('<ol id="20"><li>a</li><li>b</li><li>c</li></ol>');
    outdent(mc, 0);
    expectDomOrderMatchesIdOrder(mc);
  });

  it('LAST item outdents after the list', () => {
    const mc = buildBook('<ol id="20"><li>a</li><li>b</li><li>c</li></ol>');
    outdent(mc, 2);
    expectDomOrderMatchesIdOrder(mc);
  });

  it('MIDDLE item splits the list and both new nodes stay between their neighbours', () => {
    const mc = buildBook('<ol id="20"><li>a</li><li>b</li><li>c</li></ol>');
    outdent(mc, 1);

    expect(mc.querySelectorAll('.chunk > ol').length).toBe(2);
    const ids = domIds(mc);
    for (const id of ids.slice(1, -1)) {
      expect(parseFloat(id)).toBeGreaterThanOrEqual(20);
      expect(parseFloat(id)).toBeLessThan(30);
    }
    expectDomOrderMatchesIdOrder(mc);
  });
});

describe('Toolbar: converting an <li> to a blockquote splits the list', () => {
  const convert = async (mc, liIndex) => {
    const converter = new ListConverter({ currentBookId: 'bookA', saveToIndexedDBCallback: vi.fn() });
    await converter.convertListItemToBlock(mc.querySelectorAll('li')[liIndex], 'blockquote');
  };

  it('a FIRST-item conversion sorts after the list it was lifted out of', async () => {
    const mc = buildBook('<ol id="20"><li>a</li><li>b</li><li>c</li></ol>');
    await convert(mc, 0);
    expectDomOrderMatchesIdOrder(mc);
  });

  it('a MIDDLE-item conversion keeps the block and the remainder list in order', async () => {
    const mc = buildBook('<ol id="20"><li>a</li><li>b</li><li>c</li></ol>');
    await convert(mc, 1);
    expect(mc.querySelector('.chunk > blockquote')).not.toBeNull();
    expectDomOrderMatchesIdOrder(mc);
  });

  // The reference node for the insert has to be a child of the parent being inserted
  // into. It used to be the top-level <li>'s next sibling — a child of the LIST — so
  // insertBefore threw for any item not under the last top-level bullet, AND the
  // targetItem.remove() that runs first had already eaten the content.
  it('converts an item in a NESTED list without throwing or losing it', async () => {
    const mc = buildBook('<ol id="20"><li>one<ul><li>nested A</li><li>nested B</li></ul></li><li>two</li></ol>');
    await convert(mc, 1); // "nested A" — under the FIRST of two top-level bullets

    const bq = mc.querySelector('.chunk > blockquote');
    expect(bq).not.toBeNull();
    expect(bq.textContent).toContain('nested A');
    expect(mc.textContent).toContain('nested B');
    expect(mc.textContent).toContain('two');
    expectDomOrderMatchesIdOrder(mc);
  });

  // The lower bound must be the LIST, not the node before it. With a wide gap below the
  // list and a tight one above, bounding by the previous sibling mints a midpoint that
  // sorts BELOW the list the block was lifted out of — while sitting after it in the DOM.
  it('a list sitting high in its id gap still gets a block that sorts after it', async () => {
    const mc = buildBook('<ol id="20"><li>a</li><li>b</li><li>c</li></ol>', { before: '10', after: '21' });
    await convert(mc, 1);
    const ids = domIds(mc);
    expect(ids).toContain('20');
    for (const id of ids.slice(1, -1)) {
      expect(parseFloat(id)).toBeGreaterThanOrEqual(20);
      expect(parseFloat(id)).toBeLessThan(21);
    }
    expectDomOrderMatchesIdOrder(mc);
  });
});
