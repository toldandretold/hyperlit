/**
 * List conversions may NEVER create block content inside a <p>/<h1>–<h6>.
 *
 * The corruption chain this pins (terms, 2026-10-16): remove-list copied an
 * <li>'s innerHTML — nested <ol> included — into a <p>, and the heading
 * converter did the same into an <h3> (`<h3>Warning<ol>…</ol></h3>`). Illegal
 * nesting survives in the live DOM (moves never re-parse) but collapses to an
 * EMPTY node on the next parse, and — worse — every id minted INSIDE such a
 * wrapper sees no numeric siblings, so `generateIdBetween(null, null)` restarts
 * numbering at "1": a later list-escape inside the trapped <ol> minted ids
 * 1/101/201 mid-book, the save queue couldn't find the nodes, and the
 * integrity report showed `<p id="2162"><p id="1">` with an empty IDB record.
 *
 * Also pinned here: asking for a heading on a list item must mint a HEADING —
 * the converter used to receive the word "heading" and fall through to <pre>.
 *
 * These tests run the REAL idHelpers (the id-position review gate: mocking the
 * generator is exactly what hides this class of bug).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installDecimalIdSelectorShim } from '../_helpers/decimalIdSelectorShim.js';

installDecimalIdSelectorShim();

const { batchUpdateIndexedDBRecords } = vi.hoisted(() => ({
  batchUpdateIndexedDBRecords: vi.fn(),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({ batchUpdateIndexedDBRecords }));

import { ListConverter } from '../../../resources/js/editToolbar/listConverter';
import { handleRemoveList } from '../../../resources/js/editToolbar/blockFormat/listFormat';
import { handleHeadingFormat } from '../../../resources/js/editToolbar/blockFormat/headingFormat';
import { hoistIllegalBlockChildren } from '../../../resources/js/editToolbar/blockFormat/blockChildHoist';
import { PHRASING_ILLEGAL_CHILD_SELECTOR } from '../../../resources/js/utilities/blockElements';

/** Splice `html` in as the node between paragraphs 10 and 30 (ids must land in that gap). */
function buildBook(html, { before = '10', after = '30' } = {}) {
  document.body.innerHTML = '';
  const mc = document.createElement('div');
  mc.className = 'main-content';
  mc.innerHTML = `
    <div class="chunk" data-chunk-id="1" contenteditable="true">
      <p id="${before}">before</p>
      ${html}
      <p id="${after}">after</p>
    </div>`;
  document.body.appendChild(mc);
  return mc;
}

function domIds(mc) {
  return Array.from(mc.querySelectorAll('.chunk > [id]'))
    .map((el) => el.id)
    .filter((id) => /^\d+(\.\d+)?$/.test(id));
}

function expectDomOrderMatchesIdOrder(mc) {
  const ids = domIds(mc);
  const sorted = [...ids].sort((a, b) => parseFloat(a) - parseFloat(b));
  expect(ids).toEqual(sorted);
  expect(new Set(ids).size).toBe(ids.length);
}

/** No <p>/<h*> anywhere in the chunk may hold block-level content. */
function expectPhrasingOnly(mc) {
  for (const el of mc.querySelectorAll('p, h1, h2, h3, h4, h5, h6')) {
    expect(
      el.querySelector(PHRASING_ILLEGAL_CHILD_SELECTOR),
      `<${el.tagName.toLowerCase()} id="${el.id}"> holds illegal block content: ${el.innerHTML}`
    ).toBeNull();
  }
}

/**
 * Fabricate an ILLEGALLY-nested node by MOVING children in — `innerHTML` can't
 * do it, because the HTML parser auto-closes a <p> before block content (which
 * is exactly how the live corruption stays invisible until the next parse).
 */
function makeCorruptNode(tag, id, html) {
  const el = document.createElement(tag);
  el.id = id;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  while (tmp.firstChild) el.appendChild(tmp.firstChild);
  return el;
}

/** buildBook, but with a hand-built (possibly corrupt) node in the 20-slot. */
function buildBookWithNode(el, opts) {
  const mc = buildBook('<p id="slot-20">x</p>', opts);
  mc.querySelector('[id="slot-20"]').replaceWith(el);
  return mc;
}

function cursorAt(node, offset = 0) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return sel;
}

/** Minimal BlockCommandContext — undo exercised live; saves captured. */
function makeSelf() {
  return {
    currentBookId: 'bookA',
    editableSelector: '.main-content',
    selectionManager: { currentSelection: window.getSelection() },
    undoManager: null,
    saveToIndexedDBCallback: vi.fn(),
    deleteFromIndexedDBCallback: vi.fn(),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  delete window.__pendingRenumbering;
});

describe('toolbar: list item → heading (convertListItemToBlock)', () => {
  const convert = async (li, level) => {
    const converter = new ListConverter({ currentBookId: 'bookA', saveToIndexedDBCallback: vi.fn() });
    return converter.convertListItemToBlock(li, level);
  };

  it('mints the requested HEADING, not a <pre>', async () => {
    const mc = buildBook('<ol id="20"><li>a</li><li>b</li><li>c</li></ol>');
    await convert(mc.querySelectorAll('li')[1], 'h3');

    const h3 = mc.querySelector('.chunk > h3');
    expect(h3).not.toBeNull();
    expect(h3.textContent).toBe('b');
    expect(mc.querySelector('pre')).toBeNull();
    expect(mc.querySelectorAll('.chunk > ol').length).toBe(2); // split around it
    expectDomOrderMatchesIdOrder(mc);
    expectPhrasingOnly(mc);
  });

  it('an item carrying a NESTED list: heading keeps the text, nested list is hoisted after it', async () => {
    // The user-reported shape: <li>Warning<ol>Event/Consequence/Repair</ol></li>
    const mc = buildBook(
      '<ol id="20"><li>Warning<ol><li>Event</li><li>Consequence</li><li>Repair</li></ol></li><li>two</li></ol>'
    );
    await convert(mc.querySelector('li'), 'h3');

    const h3 = mc.querySelector('.chunk > h3');
    expect(h3).not.toBeNull();
    expect(h3.textContent).toBe('Warning');
    // The nested list survives — as a SIBLING node, never inside the heading.
    expect(h3.querySelector('ol, ul')).toBeNull();
    const hoisted = h3.nextElementSibling;
    expect(hoisted.tagName).toBe('OL');
    expect(hoisted.textContent).toContain('Repair');
    expect(mc.textContent).toContain('two');
    // Every minted id stays in the 20→30 gap — numbering must NOT restart at 1.
    for (const id of domIds(mc).slice(1, -1)) {
      expect(parseFloat(id)).toBeGreaterThanOrEqual(20);
      expect(parseFloat(id)).toBeLessThan(30);
    }
    expectDomOrderMatchesIdOrder(mc);
    expectPhrasingOnly(mc);
  });

  it('persists the hoisted nested list (it is a brand-new node)', async () => {
    const save = vi.fn();
    const mc = buildBook('<ol id="20"><li>Warning<ol><li>Event</li></ol></li><li>two</li></ol>');
    const converter = new ListConverter({ currentBookId: 'bookA', saveToIndexedDBCallback: save });
    await converter.convertListItemToBlock(mc.querySelector('li'), 'h2');

    const hoistedId = mc.querySelector('.chunk > h2').nextElementSibling.id;
    expect(save.mock.calls.some(([id]) => String(id) === hoistedId)).toBe(true);
  });
});

describe('toolbar: remove list (handleRemoveList)', () => {
  it('flat list unwraps to paragraphs with in-gap ids', async () => {
    const mc = buildBook('<ul id="20"><li>a</li><li>b</li></ul>');
    const self = makeSelf();
    cursorAt(mc.querySelector('li').firstChild, 0);
    self.selectionManager.currentSelection = window.getSelection();
    await handleRemoveList(self, mc.querySelector('li'));

    expect(mc.querySelector('.chunk > ul')).toBeNull();
    const ps = mc.querySelectorAll('.chunk > p');
    expect(ps.length).toBe(4); // before, a, b, after
    expectDomOrderMatchesIdOrder(mc);
    expectPhrasingOnly(mc);
  });

  it('an <li> holding a NESTED list unwraps into a <div>, never a <p> with a list inside', async () => {
    const mc = buildBook('<ul id="20"><li>plain</li><li>Warning<ol><li>X</li></ol></li></ul>');
    const self = makeSelf();
    cursorAt(mc.querySelector('li').firstChild, 0);
    self.selectionManager.currentSelection = window.getSelection();
    await handleRemoveList(self, mc.querySelector('li'));

    expect(mc.querySelector('.chunk > p ol, .chunk > p ul')).toBeNull();
    const div = mc.querySelector('.chunk > div');
    expect(div).not.toBeNull();
    expect(div.textContent).toContain('Warning');
    expect(div.querySelector('ol')).not.toBeNull(); // nested list survives, legally
    expectDomOrderMatchesIdOrder(mc);
    expectPhrasingOnly(mc);
  });
});

describe('toolbar: heading conversion on a node carrying block content (handleHeadingFormat)', () => {
  it('p→h3 hoists a trapped list instead of swallowing it (the <h3>Warning<ol>…</ol></h3> report)', async () => {
    const corrupt = makeCorruptNode('p', '20', 'Warning<ol><li>X</li><li>Y</li></ol>');
    const mc = buildBookWithNode(corrupt);
    const self = makeSelf();
    cursorAt(corrupt.firstChild, 2);
    self.selectionManager.currentSelection = window.getSelection();
    await handleHeadingFormat(self, false, corrupt, 'h3');

    const h3 = mc.querySelector('.chunk > h3');
    expect(h3).not.toBeNull();
    expect(h3.id).toBe('20');
    expect(h3.textContent).toBe('Warning');
    expect(h3.querySelector('ol')).toBeNull();
    const hoisted = h3.nextElementSibling;
    expect(hoisted.tagName).toBe('OL');
    expect(parseFloat(hoisted.id)).toBeGreaterThan(20);
    expect(parseFloat(hoisted.id)).toBeLessThan(30);
    // The hoisted node is new — it must be persisted.
    expect(self.saveToIndexedDBCallback.mock.calls.some(([id]) => String(id) === hoisted.id)).toBe(true);
    expectDomOrderMatchesIdOrder(mc);
    expectPhrasingOnly(mc);
  });

  it('h3→p toggle on an already-corrupt heading repairs the nesting on the way out', async () => {
    const mc = buildBook('<h3 id="20">Warning<ol><li>X</li></ol></h3>');
    const self = makeSelf();
    cursorAt(mc.querySelector('h3').firstChild, 0);
    self.selectionManager.currentSelection = window.getSelection();
    await handleHeadingFormat(self, false, mc.querySelector('h3'), 'h3'); // same level → toggles to <p>

    const p = mc.querySelector('.chunk > p[id="20"]');
    expect(p).not.toBeNull();
    expect(p.querySelector('ol')).toBeNull();
    expect(mc.textContent).toContain('X'); // list content survived the repair
    expectDomOrderMatchesIdOrder(mc);
    expectPhrasingOnly(mc);
  });
});

describe('blockChildHoist: the shared repair', () => {
  it('re-seats blocks as siblings in document order with bounded ids', () => {
    const p = makeCorruptNode('p', '20', 'lead<ol><li>A</li></ol>middle<ul><li>B</li></ul>');
    const mc = buildBookWithNode(p);
    const hoisted = hoistIllegalBlockChildren(p, 'bookA');

    expect(hoisted.map((h) => h.tagName)).toEqual(['OL', 'UL']);
    expect(p.querySelector('ol, ul')).toBeNull();
    expect(p.textContent).toBe('leadmiddle');
    expectDomOrderMatchesIdOrder(mc);
  });

  it('gathers adjacent bare <li> children into one synthesized <ul>', () => {
    const p = makeCorruptNode('p', '20', 'lead<li>A</li><li>B</li>');
    const mc = buildBookWithNode(p);
    const hoisted = hoistIllegalBlockChildren(p, 'bookA');

    expect(hoisted.length).toBe(1);
    expect(hoisted[0].tagName).toBe('UL');
    expect(hoisted[0].querySelectorAll('li').length).toBe(2);
    expectDomOrderMatchesIdOrder(mc);
  });
});
