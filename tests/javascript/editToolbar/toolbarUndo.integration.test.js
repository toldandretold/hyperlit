/**
 * Toolbar → UndoManager integration: drives the REAL BlockFormatter command
 * handlers (blockquote/code wrap+unwrap, heading, list) with a REAL UndoManager
 * and asserts the full loop the user experiences: button action → undo restores
 * the original DOM → redo re-applies the format.
 *
 * This is the wiring no other test covers: undoManager.test.js feeds the
 * manager synthetic entries, and blockFormat.test.js stubs the manager out —
 * a button that silently stopped recording an undoable entry would fail
 * nothing. Here every action must land a working recordFormat entry.
 *
 * Native browser undo is irrelevant by design: the editor blocks
 * historyUndo/historyRedo and routes Cmd+Z to this UndoManager (see
 * undoInterception.test.js for that layer).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/utilities/operationState', () => ({
  setProgrammaticUpdateInProgress: vi.fn(),
}));
// idHelpers transitively imports app.ts (module side effects) — stub the used
// surface. setElementIds must actually assign an id: remove-list's undo closure
// finds the extra paragraphs by the ids this handed out.
vi.mock('../../../resources/js/utilities/idHelpers', () => {
  let nextGeneratedId = 0;
  return {
    asLineId: (s) => s,
    setElementIds: vi.fn((el) => { if (!el.id) el.id = `gen${++nextGeneratedId}`; }),
    findPreviousElementId: vi.fn(() => null),
    findNextElementId: vi.fn(() => null),
  };
});
vi.mock('../../../resources/js/indexedDB/index', () => ({
  batchUpdateIndexedDBRecords: vi.fn(() => Promise.resolve()),
  updateSingleIndexedDBRecord: vi.fn(() => Promise.resolve()),
  deleteIndexedDBRecord: vi.fn(() => Promise.resolve()),
}));

import { BlockFormatter } from '../../../resources/js/editToolbar/blockFormatter';
import { UndoManager } from '../../../resources/js/editToolbar/undoManager';

const BOOK = 'book1';
let um, bf, selectionManager, saveCb;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  um = new UndoManager();
  saveCb = vi.fn(() => Promise.resolve());
  selectionManager = { currentSelection: null, lastValidRange: null };
  bf = new BlockFormatter({
    currentBookId: BOOK,
    selectionManager,
    buttonStateManager: { updateButtonStates: vi.fn() },
    saveToIndexedDBCallback: saveCb,
    undoManager: um,
  });
});

function mount(html) {
  document.body.innerHTML =
    `<div class="main-content" id="${BOOK}" contenteditable="true">${html}</div>`;
  return document.getElementById(BOOK);
}

// Seat the caret in the first text node of el and hand the live Selection to
// the fake selectionManager (the command handlers read focusNode/focusOffset).
function caretIn(el, offset = 0) {
  const textNode = el.firstChild ?? el;
  const r = document.createRange();
  r.setStart(textNode, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  selectionManager.currentSelection = sel;
}

const doUndo = () => um.undo(BOOK, saveCb, () => {});
const doRedo = () => um.redo(BOOK, saveCb, () => {});
// undo()/redo() clear their programmatic-update flags in a setTimeout(0).
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('blockquote button → undo → redo', () => {
  it('wrap records an undoable entry; undo restores the <p>, redo re-wraps', async () => {
    mount('<p id="10" data-node-id="n10">quote <em>me</em></p>');
    const p = document.getElementById('10');
    const em = p.querySelector('em');
    caretIn(p);

    await bf.wrapBlock(p, 'blockquote');
    expect(document.getElementById('10').tagName).toBe('BLOCKQUOTE');
    expect(um.hasUndo(BOOK)).toBe(true);

    doUndo();
    const restored = document.getElementById('10');
    expect(restored.tagName).toBe('P');
    expect(restored.innerHTML).toBe('quote <em>me</em>');
    expect(restored.getAttribute('data-node-id')).toBe('n10');
    expect(restored.querySelector('em')).toBe(em);   // live node moved, never cloned
    expect(um.hasRedo(BOOK)).toBe(true);

    doRedo();
    expect(document.getElementById('10').tagName).toBe('BLOCKQUOTE');
    expect(document.getElementById('10').querySelector('em')).toBe(em);
    await flush();
  });

  it('unwrap records an undoable entry; undo restores the <blockquote>', async () => {
    mount('<blockquote id="11" data-node-id="n11">already quoted<br></blockquote>');
    const bq = document.getElementById('11');
    caretIn(bq);

    await bf.unwrapBlock(bq, 'blockquote');
    expect(document.getElementById('11').tagName).toBe('P');

    doUndo();
    expect(document.getElementById('11').tagName).toBe('BLOCKQUOTE');
    doRedo();
    expect(document.getElementById('11').tagName).toBe('P');
    await flush();
  });
});

describe('code button → undo → redo', () => {
  it('round-trips p → pre>code → undo → redo', async () => {
    mount('<p id="20" data-node-id="n20">const x = 1;</p>');
    const p = document.getElementById('20');
    caretIn(p);

    await bf.wrapBlock(p, 'code');
    const pre = document.getElementById('20');
    expect(pre.tagName).toBe('PRE');
    expect(pre.querySelector('code').textContent).toBe('const x = 1;');

    doUndo();
    expect(document.getElementById('20').tagName).toBe('P');
    expect(document.getElementById('20').textContent).toBe('const x = 1;');

    doRedo();
    expect(document.getElementById('20').tagName).toBe('PRE');
    await flush();
  });
});

describe('heading button → undo → redo', () => {
  it('p → h2 records an undoable entry; undo restores the <p>, redo re-applies', async () => {
    mount('<p id="30" data-node-id="n30">a title</p>');
    caretIn(document.getElementById('30'));

    await bf.handleHeadingFormat(false, document.getElementById('30'), 'h2');
    expect(document.getElementById('30').tagName).toBe('H2');
    expect(um.hasUndo(BOOK)).toBe(true);

    doUndo();
    const restored = document.getElementById('30');
    expect(restored.tagName).toBe('P');
    expect(restored.textContent).toBe('a title');
    expect(restored.getAttribute('data-node-id')).toBe('n30');

    doRedo();
    expect(document.getElementById('30').tagName).toBe('H2');
    await flush();
  });

  it('h2 → p toggle (same level) is also undoable', async () => {
    mount('<h2 id="31">demote me</h2>');
    caretIn(document.getElementById('31'));

    await bf.handleHeadingFormat(false, document.getElementById('31'), 'h2');
    expect(document.getElementById('31').tagName).toBe('P');

    doUndo();
    expect(document.getElementById('31').tagName).toBe('H2');
    doRedo();
    expect(document.getElementById('31').tagName).toBe('P');
    await flush();
  });
});

describe('list button → undo → redo', () => {
  it('p → ul records an undoable entry; undo restores the <p>', async () => {
    mount('<p id="40" data-node-id="n40">item text</p>');
    const p = document.getElementById('40');
    caretIn(p);

    await bf.handleListFormat('ul', p, false);
    const afterFormat = document.getElementById('40');
    expect(afterFormat.tagName).toBe('UL');
    expect(afterFormat.querySelector('li').textContent).toBe('item text');
    expect(um.hasUndo(BOOK)).toBe(true);

    doUndo();
    const restored = document.getElementById('40');
    expect(restored.tagName).toBe('P');
    expect(restored.textContent).toBe('item text');

    doRedo();
    expect(document.getElementById('40').tagName).toBe('UL');
    await flush();
  });
});

describe('ordered-list button → undo → redo', () => {
  it('p → ol records an undoable entry; undo restores the <p>', async () => {
    mount('<p id="41" data-node-id="n41">step one</p>');
    const p = document.getElementById('41');
    caretIn(p);

    await bf.handleListFormat('ol', p, false);
    expect(document.getElementById('41').tagName).toBe('OL');
    expect(um.hasUndo(BOOK)).toBe(true);

    doUndo();
    expect(document.getElementById('41').tagName).toBe('P');
    expect(document.getElementById('41').textContent).toBe('step one');

    doRedo();
    expect(document.getElementById('41').tagName).toBe('OL');
    await flush();
  });
});

describe('remove-list button → undo → redo', () => {
  it('ul → paragraphs records an undoable entry; undo restores the full list', async () => {
    mount('<ul id="70" data-node-id="n70"><li>one</li><li>two</li></ul>');
    const firstLi = document.querySelector('li');
    caretIn(firstLi);

    await bf.handleRemoveList(firstLi);
    expect(document.querySelector('ul')).toBeNull();
    expect(document.getElementById('70').tagName).toBe('P');
    expect(document.getElementById('70').textContent).toBe('one');
    const paragraphs = document.querySelectorAll(`#${BOOK} > p`);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1].textContent).toBe('two');
    expect(um.hasUndo(BOOK)).toBe(true);

    doUndo();
    const restored = document.getElementById('70');
    expect(restored.tagName).toBe('UL');
    expect(restored.querySelectorAll('li')).toHaveLength(2);
    expect(document.querySelectorAll(`#${BOOK} > p`)).toHaveLength(0); // extra <p> cleaned up

    doRedo();
    expect(document.querySelector('ul')).toBeNull();
    expect(document.querySelectorAll(`#${BOOK} > p`)).toHaveLength(2);
    await flush();
  });
});

describe('multi-format session', () => {
  it('sequential formats unwind in reverse order', async () => {
    mount('<p id="50">first</p><p id="51">second</p>');
    const p50 = document.getElementById('50');
    caretIn(p50);
    await bf.wrapBlock(p50, 'blockquote');

    const p51 = document.getElementById('51');
    caretIn(p51);
    await bf.handleHeadingFormat(false, p51, 'h3');

    expect(document.getElementById('50').tagName).toBe('BLOCKQUOTE');
    expect(document.getElementById('51').tagName).toBe('H3');

    doUndo(); // most recent first: heading
    expect(document.getElementById('51').tagName).toBe('P');
    expect(document.getElementById('50').tagName).toBe('BLOCKQUOTE');

    doUndo(); // then the blockquote
    expect(document.getElementById('50').tagName).toBe('P');
    expect(um.hasUndo(BOOK)).toBe(false);
    await flush();
  });
});
