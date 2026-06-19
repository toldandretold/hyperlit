/**
 * UndoManager — live-system test.
 *
 * UndoManager is the SOLE undo/redo system: a lightweight, in-memory, per-book
 * stack driving the toolbar buttons + keyboard shortcuts. There is no persistence
 * (the old IndexedDB `redoLog` system was removed). This test pins the behaviour a
 * realistic editing flow exercises across all three entry types:
 *   - InputEntry (typing): capture → seal → undo restores oldHTML → redo restores newHTML
 *   - FormatEntry: undo runs undoFn → redo runs redoFn
 *   - StructuralEntry: split/merge snapshot → undo restores the tree → redo re-applies
 *   - mixed multi-edit undo/redo chains
 *   - category-switch sealing (typing → deletion seals a separate entry)
 *   - per-book stack isolation
 *   - onUndo/onRedo entry callbacks (used by the hypercite paste path)
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

    it('seals a separate entry when the input category switches (typing → deletion)', () => {
      setupDom('<p id="n1">old</p>');
      const um = new UndoManager();
      const p = document.getElementById('n1');

      um.startCapture(p, BOOK);
      p.innerHTML = 'typed';
      um.finalizeCapture(p, BOOK, 'insertText');        // category: insertion
      p.innerHTML = 'type';
      um.finalizeCapture(p, BOOK, 'deleteContentBackward'); // category: deletion → seals prev
      um.sealGroup();                                    // seals the deletion group

      // Two distinct entries: the insertion and the deletion
      const saveCb = vi.fn();
      const setFlag = vi.fn();

      um.undo(BOOK, saveCb, setFlag);                    // undo deletion → "typed"
      expect(document.getElementById('n1').innerHTML).toBe('typed');
      expect(um.hasUndo(BOOK)).toBe(true);

      um.undo(BOOK, saveCb, setFlag);                    // undo insertion → "old"
      expect(document.getElementById('n1').innerHTML).toBe('old');
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

  describe('structural (StructuralEntry)', () => {
    it('undo removes an added block (split) and redo re-inserts it', () => {
      setupDom('<p id="n1">first</p>');
      const um = new UndoManager();
      const editable = document.getElementById(BOOK);
      const p1 = document.getElementById('n1');

      um.snapshotForStructural(BOOK, p1);   // snapshot: [n1]

      // Simulate Enter/split: a new block appears after n1
      const p2 = document.createElement('p');
      p2.id = 'n2';
      p2.innerHTML = 'second';
      editable.appendChild(p2);

      const entry = um.finalizeStructural(BOOK);
      expect(entry).not.toBeNull();
      expect(entry.added).toHaveLength(1);
      expect(entry.added[0].id).toBe('n2');

      um.undo(BOOK, vi.fn(), vi.fn());
      expect(document.getElementById('n2')).toBeNull();
      expect(document.getElementById('n1')).not.toBeNull();

      um.redo(BOOK, vi.fn(), vi.fn());
      expect(document.getElementById('n2')).not.toBeNull();
      expect(document.getElementById('n2').innerHTML).toBe('second');
    });

    it('undo re-inserts a removed block (merge) and redo removes it again', () => {
      setupDom('<p id="n1">first</p><p id="n2">second</p>');
      const um = new UndoManager();
      const p1 = document.getElementById('n1');

      um.snapshotForStructural(BOOK, p1);   // snapshot: [n1, n2]

      // Simulate Backspace-at-boundary merge: n2 is removed
      document.getElementById('n2').remove();

      const entry = um.finalizeStructural(BOOK);
      expect(entry).not.toBeNull();
      expect(entry.removed).toHaveLength(1);
      expect(entry.removed[0].id).toBe('n2');

      um.undo(BOOK, vi.fn(), vi.fn());
      expect(document.getElementById('n2')).not.toBeNull();
      expect(document.getElementById('n2').innerHTML).toBe('second');

      um.redo(BOOK, vi.fn(), vi.fn());
      expect(document.getElementById('n2')).toBeNull();
    });
  });

  describe('mixed multi-edit chain', () => {
    it('undoes input → format → input in reverse order and redoes forward', () => {
      setupDom('<p id="n1">A</p>');
      const um = new UndoManager();
      const p = document.getElementById('n1');

      // 1. input: A → B
      um.startCapture(p, BOOK);
      p.innerHTML = 'B';
      um.finalizeCapture(p, BOOK, 'insertText');
      um.sealGroup();

      // 2. format: B → C (undoFn returns to B, redoFn re-applies C)
      p.innerHTML = 'C';
      um.recordFormat('n1',
        (cur) => { cur.innerHTML = 'B'; return cur; },
        (cur) => { cur.innerHTML = 'C'; return cur; },
        BOOK, 0);

      // 3. input: C → D
      um.startCapture(p, BOOK);
      p.innerHTML = 'D';
      um.finalizeCapture(p, BOOK, 'insertText');
      um.sealGroup();

      const get = () => document.getElementById('n1').innerHTML;

      um.undo(BOOK, vi.fn(), vi.fn()); expect(get()).toBe('C'); // undo input2
      um.undo(BOOK, vi.fn(), vi.fn()); expect(get()).toBe('B'); // undo format
      um.undo(BOOK, vi.fn(), vi.fn()); expect(get()).toBe('A'); // undo input1
      expect(um.hasUndo(BOOK)).toBe(false);

      um.redo(BOOK, vi.fn(), vi.fn()); expect(get()).toBe('B'); // redo input1
      um.redo(BOOK, vi.fn(), vi.fn()); expect(get()).toBe('C'); // redo format
      um.redo(BOOK, vi.fn(), vi.fn()); expect(get()).toBe('D'); // redo input2
      expect(um.hasRedo(BOOK)).toBe(false);
    });
  });

  describe('onUndo / onRedo entry callbacks', () => {
    it('fires onUndo on undo and onRedo on redo (scheduled after the flag clears)', async () => {
      vi.useFakeTimers();
      try {
        setupDom('<p id="n1">old</p>');
        const um = new UndoManager();
        const onUndo = vi.fn().mockResolvedValue(undefined);
        const onRedo = vi.fn().mockResolvedValue(undefined);

        // Mirror the hypercite paste path: an input entry carrying link/relink hooks.
        um._pushUndo(BOOK, {
          type: 'input', elementId: 'n1', oldHTML: 'old', newHTML: 'new',
          bookId: BOOK, cursorBefore: 0, cursorAfter: 0, onUndo, onRedo,
        });

        um.undo(BOOK, vi.fn(), vi.fn());
        await vi.runAllTimersAsync();
        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(onRedo).not.toHaveBeenCalled();

        um.redo(BOOK, vi.fn(), vi.fn());
        await vi.runAllTimersAsync();
        expect(onRedo).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
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
      // hasAnyUndo() is the live cross-book fallback used by the toolbar/keydown wiring
      expect(um.hasAnyUndo()).toBe(true);

      // Undo on an empty stack is a no-op (does not throw, does not touch DOM)
      um.undo('otherBook', vi.fn(), vi.fn());
      expect(document.getElementById('n1').innerHTML).toBe('new');
    });
  });
});
