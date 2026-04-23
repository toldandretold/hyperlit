/**
 * FormattingUndoManager
 *
 * Lightweight undo/redo stack for block-level formatting operations that
 * can't use native browser undo (e.g. blockquote/code wrap/unwrap,
 * multi-block heading changes, pre→heading).
 *
 * Cursor-only heading changes use `document.execCommand('formatBlock')`
 * which IS natively undoable — this stack is only for `replaceChild` operations.
 */
export class FormattingUndoManager {
  constructor() {
    this.undoStack = []; // { elementId, oldOuterHTML, newOuterHTML, bookId }
    this.redoStack = [];
  }

  /**
   * Record an undo entry before a replaceChild operation.
   * @param {string} elementId - The ID of the element being replaced
   * @param {string} oldOuterHTML - The outerHTML before replacement
   * @param {string} newOuterHTML - The outerHTML after replacement
   * @param {string} bookId - The book ID for IndexedDB saves
   */
  recordUndo(elementId, oldOuterHTML, newOuterHTML, bookId) {
    this.undoStack.push({ elementId, oldOuterHTML, newOuterHTML, bookId });
    this.redoStack = [];
  }

  /**
   * Undo the last replaceChild operation.
   * @param {Function} saveCallback - (id, html, options) => Promise — saves to IndexedDB
   * @param {Function} setFormattingFlag - (boolean) => void — sets isFormatting on BlockFormatter
   */
  undo(saveCallback, setFormattingFlag) {
    if (this.undoStack.length === 0) return;

    const entry = this.undoStack.pop();
    setFormattingFlag(true);

    const current = document.getElementById(entry.elementId);
    if (current) {
      const template = document.createElement('template');
      template.innerHTML = entry.oldOuterHTML.trim();
      const restored = template.content.firstChild;
      current.parentNode.replaceChild(restored, current);

      if (saveCallback) {
        saveCallback(entry.elementId, entry.oldOuterHTML, { bookId: entry.bookId });
      }
    }

    this.redoStack.push(entry);

    setTimeout(() => {
      setFormattingFlag(false);
    }, 100);
  }

  /**
   * Redo the last undone operation.
   * @param {Function} saveCallback - (id, html, options) => Promise — saves to IndexedDB
   * @param {Function} setFormattingFlag - (boolean) => void — sets isFormatting on BlockFormatter
   */
  redo(saveCallback, setFormattingFlag) {
    if (this.redoStack.length === 0) return;

    const entry = this.redoStack.pop();
    setFormattingFlag(true);

    const current = document.getElementById(entry.elementId);
    if (current) {
      const template = document.createElement('template');
      template.innerHTML = entry.newOuterHTML.trim();
      const replacement = template.content.firstChild;
      current.parentNode.replaceChild(replacement, current);

      if (saveCallback) {
        saveCallback(entry.elementId, entry.newOuterHTML, { bookId: entry.bookId });
      }
    }

    this.undoStack.push(entry);

    setTimeout(() => {
      setFormattingFlag(false);
    }, 100);
  }

  /**
   * Clear both stacks (e.g. after user types, so stale entries
   * don't interfere with native text undo).
   */
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  hasUndo() {
    return this.undoStack.length > 0;
  }

  hasRedo() {
    return this.redoStack.length > 0;
  }
}
