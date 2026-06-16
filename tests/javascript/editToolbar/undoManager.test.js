/**
 * UndoManager — LIVE-PATH characterization test.
 *
 * Pins the undo/redo behaviour that a realistic editing flow actually exercises:
 *   - typing capture → seal → undo restores oldHTML → redo restores newHTML
 *   - format entry → undo runs undoFn → redo runs redoFn
 *   - per-book stack isolation
 *
 * Doubles as a LIVENESS PROBE for the suspected legacy/active-undo entanglement
 * (see the file's header flag): the paths this test drives are the live ones. Code in
 * undoManager.ts that nothing here (or a real undo/redo) reaches is a cleanup candidate
 * for the deferred undo-untangle gate. This test exists to make the surgical .js→.ts
 * conversion verifiable, NOT to pin the legacy tangle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// operationState pulls in app wiring we don't want in a unit test.
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setProgrammaticUpdateInProgress: vi.fn(),
}));

import { UndoManager } from '../../../resources/js/editToolbar/undoManager';

const BOOK = 'book1';

function setupDom(innerHTML) {
  document.body.innerHTML =
    `<div class="main-content" id="${BOOK}" contenteditable="true">${innerHTML}</div>`;
}

describe('UndoManager (live path)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('typing (InputEntry)', () => {
    it('undo restores oldHTML and redo restores newHTML', () => {
      setupDom('<p id="n1">old</p>');
      const um = new UndoManager();
      const p = document.getElementById('n1');

      um.startCapture(p, BOOK);      // snapshot oldHTML = "old"
      p.innerHTML = 'new';
      um.finalizeCapture(p, BOOK, 'insertText');
      um.sealGroup();                // push InputEntry

      expect(um.hasUndo(BOOK)).toBe(true);

      const saveCb = vi.fn();
      const setFlag = vi.fn();
      um.undo(BOOK, saveCb, setFlag);

      expect(document.getElementById('n1').innerHTML).toBe('old');
      expect(setFlag).toHaveBeenCalledWith(true);
      expect(saveCb).toHaveBeenCalledWith('n1', expect.any(String), { bookId: BOOK });
      expect(um.hasRedo(BOOK)).toBe(true);

      um.redo(BOOK, saveCb, setFlag);
      expect(document.getElementById('n1').innerHTML).toBe('new');
    });

    it('does not push an entry when content is unchanged', () => {
      setupDom('<p id="n1">same</p>');
      const um = new UndoManager();
      const p = document.getElementById('n1');

      um.startCapture(p, BOOK);
      um.finalizeCapture(p, BOOK, 'insertText'); // newHTML === oldHTML
      um.sealGroup();

      expect(um.hasUndo(BOOK)).toBe(false);
    });
  });

  describe('format (FormatEntry)', () => {
    it('undo runs undoFn, redo runs redoFn', () => {
      setupDom('<p id="n1">base</p>');
      const um = new UndoManager();

      const undoFn = (current) => { current.innerHTML = 'undone'; return current; };
      const redoFn = (current) => { current.innerHTML = 'redone'; return current; };
      um.recordFormat('n1', undoFn, redoFn, BOOK, 0);

      expect(um.hasUndo(BOOK)).toBe(true);

      um.undo(BOOK, vi.fn(), vi.fn());
      expect(document.getElementById('n1').innerHTML).toBe('undone');

      um.redo(BOOK, vi.fn(), vi.fn());
      expect(document.getElementById('n1').innerHTML).toBe('redone');
    });
  });

  describe('per-book isolation', () => {
    it('keeps separate stacks per bookId', () => {
      setupDom('<p id="n1">old</p>');
      const um = new UndoManager();
      const p = document.getElementById('n1');

      um.startCapture(p, BOOK);
      p.innerHTML = 'new';
      um.finalizeCapture(p, BOOK, 'insertText');
      um.sealGroup();

      expect(um.hasUndo(BOOK)).toBe(true);
      expect(um.hasUndo('otherBook')).toBe(false);

      // Undo on an empty stack is a no-op (does not throw, does not touch DOM)
      um.undo('otherBook', vi.fn(), vi.fn());
      expect(document.getElementById('n1').innerHTML).toBe('new');
    });
  });
});
