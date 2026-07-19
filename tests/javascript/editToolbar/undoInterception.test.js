/**
 * The native-undo interception layer (editToolbar/index.ts init()):
 *   - beforeinput historyUndo/historyRedo inside a contenteditable is ALWAYS
 *     preventDefaulted and routed to the custom UndoManager — native browser
 *     undo (incl. iOS shake-undo / Edit-menu undo) must never mutate the DOM.
 *   - Cmd/Ctrl+Z keydown is claimed when the UndoManager has entries.
 *   - typing-class beforeinput/input events feed startCapture/finalizeCapture,
 *     which is how execCommand-driven inline formats (bold/italic) and plain
 *     typing become undoable entries.
 *
 * Drives the REAL EditToolbar (initEditToolbar) with real document-level
 * listeners and synthetic events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// idHelpers transitively imports app.ts (module side effects) — stub the used surface.
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  asLineId: (s) => s,
  setElementIds: vi.fn(),
  findPreviousElementId: vi.fn(() => null),
  findNextElementId: vi.fn(() => null),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  batchUpdateIndexedDBRecords: vi.fn(() => Promise.resolve()),
  updateSingleIndexedDBRecord: vi.fn(() => Promise.resolve()),
  deleteIndexedDBRecord: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../resources/js/indexedDB/index.js', () => ({
  batchUpdateIndexedDBRecords: vi.fn(() => Promise.resolve()),
  updateSingleIndexedDBRecord: vi.fn(() => Promise.resolve()),
  deleteIndexedDBRecord: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../resources/js/indexedDB/nodes/batch', () => ({
  preloadFootnoteRenumberChunk: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setProgrammaticUpdateInProgress: vi.fn(),
}));
vi.mock('../../../resources/js/footnotes/footnoteInserter', () => ({}));
vi.mock('dompurify', () => ({ default: { sanitize: (s) => s } }));
vi.mock('../../../resources/js/utilities/bibtexProcessor', () => ({
  formatBibtexToCitation: vi.fn(async (b) => b),
}));

import { initEditToolbar, destroyEditToolbar } from '../../../resources/js/editToolbar/index';

const BOOK = 'book1';
let toolbar;

function buildDom() {
  document.body.innerHTML = `
    <div id="edit-toolbar">
      <button id="boldButton"></button>
      <button id="italicButton"></button>
      <button id="undoButton"></button>
      <button id="redoButton"></button>
      <button id="citation-button"></button>
      <div id="citation-mode-container" class="hidden">
        <input type="text" id="citation-search-input" />
      </div>
      <div id="citation-toolbar-results"></div>
    </div>
    <div class="main-content" id="${BOOK}" contenteditable="true"><p id="1">hello</p></div>
  `;
  return document.getElementById(BOOK);
}

function caretIn(el, offset = 0) {
  // The Cmd+Z keydown guard reads document.activeElement — seat focus on the
  // enclosing contenteditable like a real editing session.
  const editable = el.closest('[contenteditable="true"]');
  if (editable) editable.focus();
  const r = document.createRange();
  r.setStart(el.firstChild ?? el, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

const beforeInput = (target, inputType) => {
  const e = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};
const inputEvent = (target, inputType) => {
  const e = new InputEvent('input', { inputType, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};
const cmdZ = (target, { shift = false } = {}) => {
  const e = new KeyboardEvent('keydown', {
    key: 'z', metaKey: true, shiftKey: shift, bubbles: true, cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
};

// Give an entry to the undo stack via the same capture path typing uses.
function typeInto(p, newText) {
  caretIn(p);
  beforeInput(p, 'insertText');            // startCapture (snapshots oldHTML)
  p.firstChild.textContent = newText;      // the browser's edit
  inputEvent(p, 'insertText');             // finalizeCapture (records the entry)
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  buildDom();
  toolbar = initEditToolbar({ currentBookId: BOOK });
});

afterEach(() => {
  destroyEditToolbar();                    // remove the document-level listeners
  document.body.innerHTML = '';
});

describe('native undo/redo is intercepted inside contenteditable', () => {
  it('beforeinput historyUndo is preventDefaulted and routed to UndoManager.undo', () => {
    const mc = document.getElementById(BOOK);
    const undoSpy = vi.spyOn(toolbar.undoManager, 'undo');
    caretIn(document.getElementById('1'));

    const e = beforeInput(mc, 'historyUndo');

    expect(e.defaultPrevented).toBe(true);   // native undo NEVER runs in the editor
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(undoSpy.mock.calls[0][0]).toBe(BOOK);
  });

  it('beforeinput historyRedo is preventDefaulted and routed to UndoManager.redo', () => {
    const mc = document.getElementById(BOOK);
    const redoSpy = vi.spyOn(toolbar.undoManager, 'redo');
    caretIn(document.getElementById('1'));

    const e = beforeInput(mc, 'historyRedo');

    expect(e.defaultPrevented).toBe(true);
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it('historyUndo OUTSIDE a contenteditable is left alone', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const undoSpy = vi.spyOn(toolbar.undoManager, 'undo');

    const e = beforeInput(outside, 'historyUndo');

    expect(e.defaultPrevented).toBe(false);
    expect(undoSpy).not.toHaveBeenCalled();
  });
});

describe('typing capture → Cmd+Z round-trip (the bold/italic capture path)', () => {
  it('beforeinput/input capture records an undoable entry and Cmd+Z reverses the edit', async () => {
    const p = document.getElementById('1');
    typeInto(p, 'hello world');
    // Mid-typing the capture is an OPEN group (sealed after 300ms inactivity);
    // hasAnyUndo() sees it — that is what the Cmd+Z keydown guard checks.
    expect(toolbar.undoManager.hasAnyUndo()).toBe(true);

    const e = cmdZ(p);
    expect(e.defaultPrevented).toBe(true);   // claimed because the stack has an entry
    expect(p.textContent).toBe('hello');     // the edit was reversed
    expect(toolbar.undoManager.hasRedo(BOOK)).toBe(true);

    const r = cmdZ(p, { shift: true });      // Cmd+Shift+Z = redo
    expect(r.defaultPrevented).toBe(true);
    expect(document.getElementById('1').textContent).toBe('hello world');
    await new Promise((res) => setTimeout(res, 0)); // let undo/redo flag-clear timers run
  });

  it('an unchanged capture records nothing (no-op input)', () => {
    const p = document.getElementById('1');
    caretIn(p);
    beforeInput(p, 'insertText');
    inputEvent(p, 'insertText');             // finalize with identical HTML

    expect(toolbar.undoManager.hasUndo(BOOK)).toBe(false);
  });

  it('Cmd+Z with an empty stack is not claimed at keydown (beforeinput still blocks native)', () => {
    const p = document.getElementById('1');
    caretIn(p);
    const e = cmdZ(p);
    expect(e.defaultPrevented).toBe(false);  // keydown lets it through…
    const b = beforeInput(p, 'historyUndo'); // …but the resulting historyUndo is still blocked
    expect(b.defaultPrevented).toBe(true);
  });
});
