/**
 * UndoManager
 *
 * Unified undo/redo system that replaces native browser undo entirely.
 * Tracks all changes (typing, formatting, structural) in per-book stacks.
 *
 * Entry types:
 * - InputEntry:      typing, shift+enter, backspace within a single element
 * - FormatEntry:     blockquote/code/heading wrap/unwrap (closure-based)
 * - StructuralEntry: Enter (split) / Backspace-at-boundary (merge)
 */

import {
  getTextOffsetInElement,
  setCursorAtTextOffset,
  findClosestBlockParent,
} from "./toolbarDOMUtils.js";
import {
  setProgrammaticUpdateInProgress,
} from "../utilities/operationState.js";

/**
 * Resolve bookId from a DOM target element.
 * Walks up to find [data-book-id], falls back to .main-content id.
 */
function resolveBookId(target) {
  const el = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target;
  if (!el) return null;
  const bookEl = el.closest('[data-book-id]');
  return bookEl?.dataset?.bookId || document.querySelector('.main-content')?.id || null;
}

/**
 * Find the closest block element from a target node.
 */
function findBlockFromTarget(target) {
  const el = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target;
  if (!el) return null;
  const block = findClosestBlockParent(el);
  // Never return the contenteditable container itself — it's not a content block
  if (block && block.hasAttribute('contenteditable')) return null;
  return block;
}

export class UndoManager {
  constructor() {
    // Map<bookId, { undoStack: [], redoStack: [] }>
    this.stacks = new Map();

    // Current typing group being accumulated
    this._currentGroup = null; // { bookId, elementId, oldHTML, newHTML, startTime, cursorBefore, inputCategory }
    this._groupTimer = null;

    // Structural snapshot taken during beforeinput
    this._structuralSnapshot = null;
  }

  // ─── Stack access ──────────────────────────────────────────

  _getStacks(bookId) {
    if (!bookId) return { undoStack: [], redoStack: [] };
    if (!this.stacks.has(bookId)) {
      this.stacks.set(bookId, { undoStack: [], redoStack: [] });
    }
    return this.stacks.get(bookId);
  }

  _pushUndo(bookId, entry) {
    const s = this._getStacks(bookId);
    s.undoStack.push(entry);
    // Any new action clears the redo stack
    s.redoStack = [];
  }

  // ─── Typing groups (InputEntry) ────────────────────────────

  /**
   * Categorize inputType for grouping purposes.
   * Typing and deletion are different categories — switching seals the group.
   */
  _inputCategory(inputType) {
    if (!inputType) return 'unknown';
    if (inputType.startsWith('delete')) return 'deletion';
    if (inputType.startsWith('insert') || inputType === 'formatBold' || inputType === 'formatItalic') return 'insertion';
    return 'other';
  }

  /**
   * Called on `beforeinput` for typing-class events.
   * Snapshots the element's HTML if no group is open for it.
   */
  startCapture(blockElement, bookId) {
    if (!blockElement || !bookId) return;

    const elementId = blockElement.id;
    if (!elementId) {
      console.warn('[UndoManager] startCapture: block has no id', blockElement.tagName);
      return;
    }

    // If there's already a group for a DIFFERENT element or book, seal it first
    if (this._currentGroup &&
        (this._currentGroup.elementId !== elementId || this._currentGroup.bookId !== bookId)) {
      this.sealGroup();
    }

    // Start a new group if none exists
    if (!this._currentGroup) {
      const sel = window.getSelection();
      let cursorBefore = 0;
      if (sel && sel.rangeCount > 0) {
        try {
          cursorBefore = getTextOffsetInElement(blockElement, sel.focusNode, sel.focusOffset);
        } catch (e) {
          cursorBefore = 0;
        }
      }

      this._currentGroup = {
        bookId,
        elementId,
        oldHTML: blockElement.innerHTML,
        newHTML: blockElement.innerHTML,
        startTime: Date.now(),
        cursorBefore,
        inputCategory: null,
      };
    }
  }

  /**
   * Called on `input` for typing-class events.
   * Updates the group's newHTML and resets the seal timer.
   */
  finalizeCapture(blockElement, bookId, inputType) {
    if (!blockElement || !blockElement.id) return;
    if (!this._currentGroup || this._currentGroup.elementId !== blockElement.id) return;

    const category = this._inputCategory(inputType);

    // If the input category changed (e.g. typing → deletion), seal old group and start fresh
    if (this._currentGroup.inputCategory && this._currentGroup.inputCategory !== category) {
      const oldGroup = this._currentGroup;
      this.sealGroup();
      // Start a new group with the current state as baseline
      this._currentGroup = {
        bookId,
        elementId: blockElement.id,
        oldHTML: oldGroup.newHTML, // old group's final state is new group's start
        newHTML: blockElement.innerHTML,
        startTime: Date.now(),
        cursorBefore: oldGroup.cursorAfter || 0,
        inputCategory: category,
      };
    } else {
      this._currentGroup.inputCategory = category;
      this._currentGroup.newHTML = blockElement.innerHTML;
    }

    // Capture cursor position after the edit
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      try {
        this._currentGroup.cursorAfter = getTextOffsetInElement(blockElement, sel.focusNode, sel.focusOffset);
      } catch (e) {
        // ignore
      }
    }

    // Reset the seal timer (300ms of inactivity seals the group)
    this._resetSealTimer();
  }

  _resetSealTimer() {
    if (this._groupTimer) clearTimeout(this._groupTimer);
    this._groupTimer = setTimeout(() => this.sealGroup(), 300);
  }

  /**
   * Seal the current typing group: push it as an InputEntry onto the undo stack.
   */
  sealGroup() {
    if (this._groupTimer) {
      clearTimeout(this._groupTimer);
      this._groupTimer = null;
    }

    if (!this._currentGroup) return;

    const g = this._currentGroup;
    this._currentGroup = null;

    // Don't push if nothing changed
    if (g.oldHTML === g.newHTML) return;

    const entry = {
      type: 'input',
      elementId: g.elementId,
      oldHTML: g.oldHTML,
      newHTML: g.newHTML,
      bookId: g.bookId,
      cursorBefore: g.cursorBefore || 0,
      cursorAfter: g.cursorAfter || 0,
    };
    console.log(`[UndoManager] sealGroup → pushed input entry for #${g.elementId}, bookId=${g.bookId}, oldLen=${g.oldHTML.length}, newLen=${g.newHTML.length}`);
    this._pushUndo(g.bookId, entry);
  }

  // ─── Format entries (FormatEntry) ──────────────────────────

  /**
   * Record a block-level formatting operation (blockquote/code/heading wrap/unwrap).
   * Seals any pending typing group first.
   */
  /**
   * Record a block-level formatting operation.
   * @param {string} elementId
   * @param {Function} undoFn
   * @param {Function} redoFn
   * @param {string} bookId
   * @param {number} [cursorOffset] - cursor text offset captured BEFORE replaceChild
   */
  recordFormat(elementId, undoFn, redoFn, bookId, cursorOffset) {
    this.sealGroup();

    // If caller didn't pass an offset, try to read it now (may fail after replaceChild)
    if (cursorOffset == null) {
      cursorOffset = 0;
      const el = document.getElementById(elementId);
      if (el) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          try {
            cursorOffset = getTextOffsetInElement(el, sel.focusNode, sel.focusOffset);
          } catch (e) { /* selection not inside el */ }
        }
      }
    }

    this._pushUndo(bookId, {
      type: 'format',
      elementId,
      undoFn,
      redoFn,
      bookId,
      cursorOffset,
    });
  }

  // ─── Structural entries (StructuralEntry) ──────────────────

  /**
   * Snapshot elements before a structural change (Enter/split, Backspace/merge).
   * Called from beforeinput when inputType is insertParagraph or deleteContentBackward at boundary.
   */
  snapshotForStructural(bookId, blockElement) {
    this.sealGroup();

    if (!blockElement || !bookId) return;

    const editable = blockElement.closest('[contenteditable="true"]');
    if (!editable) return;

    // Snapshot all direct child block elements with their IDs and HTML
    const children = Array.from(editable.children).filter(el => el.id);
    const snapshot = children.map(el => ({
      id: el.id,
      html: el.innerHTML,
      tag: el.tagName.toLowerCase(),
      nodeId: el.getAttribute('data-node-id'),
    }));

    // Capture cursor position
    const sel = window.getSelection();
    let cursorBefore = { elementId: null, offset: 0 };
    if (sel && sel.rangeCount > 0 && blockElement.id) {
      try {
        cursorBefore = {
          elementId: blockElement.id,
          offset: getTextOffsetInElement(blockElement, sel.focusNode, sel.focusOffset),
        };
      } catch (e) {
        // ignore
      }
    }

    this._structuralSnapshot = {
      bookId,
      editableId: editable.id || null,
      editableSelector: editable.getAttribute('data-book-id')
        ? `[data-book-id="${editable.getAttribute('data-book-id')}"]`
        : `#${editable.id}`,
      children: snapshot,
      childIds: new Set(children.map(el => el.id)),
      cursorBefore,
    };
  }

  /**
   * Finalize a structural change by comparing before/after state.
   * Called from the input handler after insertParagraph or deleteContentBackward.
   */
  finalizeStructural(bookId) {
    const snap = this._structuralSnapshot;
    if (!snap || snap.bookId !== bookId) {
      this._structuralSnapshot = null;
      return null;
    }
    this._structuralSnapshot = null;

    const editable = snap.editableSelector
      ? document.querySelector(snap.editableSelector)
      : (snap.editableId ? document.getElementById(snap.editableId) : null);
    if (!editable) return null;

    const afterChildren = Array.from(editable.children).filter(el => el.id);
    const afterIds = new Set(afterChildren.map(el => el.id));

    // Determine added elements (in after but not in before)
    const added = [];
    for (const el of afterChildren) {
      if (!snap.childIds.has(el.id)) {
        const prevSibling = el.previousElementSibling;
        added.push({
          id: el.id,
          html: el.innerHTML,
          tag: el.tagName.toLowerCase(),
          nodeId: el.getAttribute('data-node-id'),
          afterId: prevSibling?.id || null,
        });
      }
    }

    // Determine removed elements (in before but not in after)
    const removed = [];
    for (let i = 0; i < snap.children.length; i++) {
      const child = snap.children[i];
      if (!afterIds.has(child.id)) {
        const prevChild = i > 0 ? snap.children[i - 1] : null;
        removed.push({
          id: child.id,
          html: child.html,
          tag: child.tag,
          nodeId: child.nodeId,
          afterId: prevChild?.id || null,
        });
      }
    }

    // Determine modified elements (same ID but different innerHTML)
    const modified = [];
    const snapMap = new Map(snap.children.map(c => [c.id, c]));
    for (const el of afterChildren) {
      const before = snapMap.get(el.id);
      if (before && before.html !== el.innerHTML) {
        modified.push({
          id: el.id,
          oldHTML: before.html,
          newHTML: el.innerHTML,
          oldTag: before.tag,
          newTag: el.tagName.toLowerCase(),
        });
      }
    }

    // Only record if something actually changed
    if (added.length === 0 && removed.length === 0 && modified.length === 0) {
      return null;
    }

    // Capture cursor after
    const sel = window.getSelection();
    let cursorAfter = { elementId: null, offset: 0 };
    if (sel && sel.rangeCount > 0) {
      const focusEl = sel.focusNode?.nodeType === Node.TEXT_NODE
        ? sel.focusNode.parentElement
        : sel.focusNode;
      const block = focusEl ? findClosestBlockParent(focusEl) : null;
      if (block && block.id) {
        try {
          cursorAfter = {
            elementId: block.id,
            offset: getTextOffsetInElement(block, sel.focusNode, sel.focusOffset),
          };
        } catch (e) {
          // ignore
        }
      }
    }

    const entry = {
      type: 'structural',
      bookId,
      modified,
      added,
      removed,
      editableSelector: snap.editableSelector,
      cursorBefore: snap.cursorBefore,
      cursorAfter,
    };

    this._pushUndo(bookId, entry);
    return entry;
  }

  // ─── Undo / Redo ──────────────────────────────────────────

  /**
   * Undo the most recent action for the given bookId.
   * @param {string} bookId
   * @param {Function} saveCallback - (id, html, opts) => Promise
   * @param {Function} setFormattingFlag - (boolean) => void
   */
  undo(bookId, saveCallback, setFormattingFlag) {
    this.sealGroup();

    const s = this._getStacks(bookId);
    if (s.undoStack.length === 0) {
      console.log(`[UndoManager] undo: nothing to undo for bookId=${bookId}`);
      return;
    }

    const entry = s.undoStack.pop();
    console.log(`[UndoManager] undo: type=${entry.type}, elementId=${entry.elementId || '(structural)'}, bookId=${bookId}, remaining=${s.undoStack.length}`);

    setProgrammaticUpdateInProgress(true);
    setFormattingFlag(true);

    try {
      switch (entry.type) {
        case 'input':
          this._undoInput(entry, saveCallback);
          break;
        case 'format':
          this._undoFormat(entry, saveCallback);
          break;
        case 'structural':
          this._undoStructural(entry, saveCallback);
          break;
      }
    } finally {
      s.redoStack.push(entry);
      // Delay clearing the flag so the MutationObserver microtask fires
      // while programmaticUpdateInProgress is still true and skips the mutations.
      // setTimeout(0) runs after microtasks, so the observer callback sees true.
      setTimeout(() => {
        setProgrammaticUpdateInProgress(false);
        setFormattingFlag(false);
        if (entry.onUndo) {
          entry.onUndo().catch(err =>
            console.error('[UndoManager] onUndo callback error:', err)
          );
        }
      }, 0);
    }
  }

  /**
   * Redo the most recent undone action for the given bookId.
   */
  redo(bookId, saveCallback, setFormattingFlag) {
    this.sealGroup();

    const s = this._getStacks(bookId);
    if (s.redoStack.length === 0) return;

    const entry = s.redoStack.pop();

    setProgrammaticUpdateInProgress(true);
    setFormattingFlag(true);

    try {
      switch (entry.type) {
        case 'input':
          this._redoInput(entry, saveCallback);
          break;
        case 'format':
          this._redoFormat(entry, saveCallback);
          break;
        case 'structural':
          this._redoStructural(entry, saveCallback);
          break;
      }
    } finally {
      s.undoStack.push(entry);
      setTimeout(() => {
        setProgrammaticUpdateInProgress(false);
        setFormattingFlag(false);
        if (entry.onRedo) {
          entry.onRedo().catch(err =>
            console.error('[UndoManager] onRedo callback error:', err)
          );
        }
      }, 0);
    }
  }

  // ─── Input undo/redo ───────────────────────────────────────

  _undoInput(entry, saveCallback) {
    const el = document.getElementById(entry.elementId);
    if (!el) {
      console.warn(`[UndoManager] _undoInput: element #${entry.elementId} not found in DOM`);
      return;
    }

    console.log(`[UndoManager] _undoInput: restoring #${entry.elementId} innerHTML (${entry.oldHTML.length} chars), cursor→${entry.cursorBefore}`);
    el.innerHTML = entry.oldHTML;

    // Ensure the contenteditable ancestor is focused before setting cursor
    const editable = el.closest('[contenteditable="true"]');
    if (editable && document.activeElement !== editable) editable.focus();

    setCursorAtTextOffset(el, entry.cursorBefore);

    if (saveCallback) {
      saveCallback(entry.elementId, el.outerHTML, { bookId: entry.bookId });
    }
  }

  _redoInput(entry, saveCallback) {
    const el = document.getElementById(entry.elementId);
    if (!el) return;

    el.innerHTML = entry.newHTML;

    const editable = el.closest('[contenteditable="true"]');
    if (editable && document.activeElement !== editable) editable.focus();

    setCursorAtTextOffset(el, entry.cursorAfter);

    if (saveCallback) {
      saveCallback(entry.elementId, el.outerHTML, { bookId: entry.bookId });
    }
  }

  // ─── Format undo/redo ─────────────────────────────────────

  _undoFormat(entry, saveCallback) {
    const current = document.getElementById(entry.elementId);
    if (!current) return;

    const newEl = entry.undoFn(current);
    if (newEl) {
      entry.elementId = newEl.id;

      // Restore cursor into the new element after replaceChild
      const editable = newEl.closest('[contenteditable="true"]');
      if (editable && document.activeElement !== editable) editable.focus();
      setCursorAtTextOffset(newEl, entry.cursorOffset || 0);

      if (saveCallback) {
        saveCallback(newEl.id, newEl.outerHTML, { bookId: entry.bookId });
      }
    }
  }

  _redoFormat(entry, saveCallback) {
    const current = document.getElementById(entry.elementId);
    if (!current) return;

    const newEl = entry.redoFn(current);
    if (newEl) {
      entry.elementId = newEl.id;

      const editable = newEl.closest('[contenteditable="true"]');
      if (editable && document.activeElement !== editable) editable.focus();
      setCursorAtTextOffset(newEl, entry.cursorOffset || 0);

      if (saveCallback) {
        saveCallback(newEl.id, newEl.outerHTML, { bookId: entry.bookId });
      }
    }
  }

  // ─── Structural undo/redo ─────────────────────────────────

  _undoStructural(entry, saveCallback) {
    const editable = document.querySelector(entry.editableSelector);
    if (!editable) return;

    // 1. Remove added elements
    for (const a of entry.added) {
      const el = document.getElementById(a.id);
      if (el) el.remove();
    }

    // 2. Re-insert removed elements
    for (const r of entry.removed) {
      const newEl = document.createElement(r.tag);
      newEl.innerHTML = r.html;
      newEl.id = r.id;
      if (r.nodeId) newEl.setAttribute('data-node-id', r.nodeId);

      if (r.afterId) {
        const afterEl = document.getElementById(r.afterId);
        if (afterEl) {
          const parent = afterEl.parentNode;
          if (afterEl.nextSibling) {
            parent.insertBefore(newEl, afterEl.nextSibling);
          } else {
            parent.appendChild(newEl);
          }
        } else {
          editable.appendChild(newEl);
        }
      } else {
        editable.insertBefore(newEl, editable.firstChild);
      }

      if (saveCallback) {
        saveCallback(r.id, newEl.outerHTML, { bookId: entry.bookId });
      }
    }

    // 3. Restore modified elements to oldHTML
    for (const m of entry.modified) {
      const el = document.getElementById(m.id);
      if (!el) continue;

      // If the tag changed, recreate the element
      if (m.oldTag && m.oldTag !== m.newTag) {
        const newEl = document.createElement(m.oldTag);
        newEl.innerHTML = m.oldHTML;
        newEl.id = m.id;
        if (el.hasAttribute('data-node-id')) {
          newEl.setAttribute('data-node-id', el.getAttribute('data-node-id'));
        }
        el.parentNode.replaceChild(newEl, el);
        if (saveCallback) {
          saveCallback(m.id, newEl.outerHTML, { bookId: entry.bookId });
        }
      } else {
        el.innerHTML = m.oldHTML;
        if (saveCallback) {
          saveCallback(m.id, el.outerHTML, { bookId: entry.bookId });
        }
      }
    }

    // 4. Restore cursor
    if (entry.cursorBefore?.elementId) {
      const cursorEl = document.getElementById(entry.cursorBefore.elementId);
      if (cursorEl) {
        const editable2 = cursorEl.closest('[contenteditable="true"]');
        if (editable2 && document.activeElement !== editable2) editable2.focus();
        setCursorAtTextOffset(cursorEl, entry.cursorBefore.offset);
      }
    }
  }

  _redoStructural(entry, saveCallback) {
    const editable = document.querySelector(entry.editableSelector);
    if (!editable) return;

    // 1. Remove the elements that were "removed" (i.e. they got re-inserted during undo, now remove again)
    for (const r of entry.removed) {
      const el = document.getElementById(r.id);
      if (el) el.remove();
    }

    // 2. Re-insert added elements
    for (const a of entry.added) {
      const newEl = document.createElement(a.tag);
      newEl.innerHTML = a.html;
      newEl.id = a.id;
      if (a.nodeId) newEl.setAttribute('data-node-id', a.nodeId);

      if (a.afterId) {
        const afterEl = document.getElementById(a.afterId);
        if (afterEl) {
          const parent = afterEl.parentNode;
          if (afterEl.nextSibling) {
            parent.insertBefore(newEl, afterEl.nextSibling);
          } else {
            parent.appendChild(newEl);
          }
        } else {
          editable.appendChild(newEl);
        }
      } else {
        editable.insertBefore(newEl, editable.firstChild);
      }

      if (saveCallback) {
        saveCallback(a.id, newEl.outerHTML, { bookId: entry.bookId });
      }
    }

    // 3. Restore modified elements to newHTML
    for (const m of entry.modified) {
      const el = document.getElementById(m.id);
      if (!el) continue;

      if (m.newTag && m.oldTag !== m.newTag) {
        const newEl = document.createElement(m.newTag);
        newEl.innerHTML = m.newHTML;
        newEl.id = m.id;
        if (el.hasAttribute('data-node-id')) {
          newEl.setAttribute('data-node-id', el.getAttribute('data-node-id'));
        }
        el.parentNode.replaceChild(newEl, el);
        if (saveCallback) {
          saveCallback(m.id, newEl.outerHTML, { bookId: entry.bookId });
        }
      } else {
        el.innerHTML = m.newHTML;
        if (saveCallback) {
          saveCallback(m.id, el.outerHTML, { bookId: entry.bookId });
        }
      }
    }

    // 4. Restore cursor
    if (entry.cursorAfter?.elementId) {
      const cursorEl = document.getElementById(entry.cursorAfter.elementId);
      if (cursorEl) {
        const editable2 = cursorEl.closest('[contenteditable="true"]');
        if (editable2 && document.activeElement !== editable2) editable2.focus();
        setCursorAtTextOffset(cursorEl, entry.cursorAfter.offset);
      }
    }
  }

  // ─── Queries ──────────────────────────────────────────────

  hasUndo(bookId) {
    if (!bookId) return false;
    const s = this.stacks.get(bookId);
    return s ? s.undoStack.length > 0 : false;
  }

  hasRedo(bookId) {
    if (!bookId) return false;
    const s = this.stacks.get(bookId);
    return s ? s.redoStack.length > 0 : false;
  }

  /**
   * Check if there are any undo entries across ALL books.
   * Used by the old keydown handler as a fallback.
   */
  hasAnyUndo() {
    for (const [, s] of this.stacks) {
      if (s.undoStack.length > 0) return true;
    }
    // Also check if there's an open typing group
    return this._currentGroup !== null;
  }

  hasAnyRedo() {
    for (const [, s] of this.stacks) {
      if (s.redoStack.length > 0) return true;
    }
    return false;
  }

  clearBook(bookId) {
    this.stacks.delete(bookId);
  }
}

export { resolveBookId, findBlockFromTarget };
