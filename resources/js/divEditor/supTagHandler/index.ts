/**
 * SupTagHandler — manages behaviour around <sup> elements (footnotes) and
 * hypercite <a> anchors in the contenteditable editor. Thin orchestrator: it
 * attaches/detaches the three standalone handlers (decomposed into sibling
 * modules) on the editable div.
 *
 * - escapeHandler  — prevents typing inside sup/hypercite (cursor escapes)
 * - deleteHandler  — Delete/Backspace at sup boundaries + confirm dialogs
 * - arrowHandler   — Arrow keys skip across a whole hypercite anchor
 */
import { hyperciteArrowHandler } from './arrowHandler';
import { supEscapeHandler } from './escapeHandler';
import { supDeleteHandler } from './deleteHandler';

type EditorEventHandler = (e: any) => void;

export class SupTagHandler {
  editableDiv: HTMLElement;
  supEscapeHandler: EditorEventHandler | null;
  supDeleteHandler: EditorEventHandler | null;
  hyperciteArrowHandler: EditorEventHandler | null;

  constructor(editableDiv: HTMLElement) {
    this.editableDiv = editableDiv;
    this.supEscapeHandler = null;
    this.supDeleteHandler = null;
    this.hyperciteArrowHandler = null;
  }

  /**
   * Attach all sup tag related event listeners
   */
  startListening(): void {
    this._attachEscapeHandler();
    this._attachDeleteHandler();
    this._attachArrowHandler();
  }

  /**
   * Remove all sup tag related event listeners
   */
  stopListening(): void {
    if (this.supEscapeHandler) {
      this.editableDiv.removeEventListener('beforeinput', this.supEscapeHandler, { capture: true });
      this.supEscapeHandler = null;
    }
    if (this.supDeleteHandler) {
      this.editableDiv.removeEventListener('beforeinput', this.supDeleteHandler, { capture: true });
      this.supDeleteHandler = null;
    }
    if (this.hyperciteArrowHandler) {
      this.editableDiv.removeEventListener('keydown', this.hyperciteArrowHandler, { capture: true });
      this.hyperciteArrowHandler = null;
    }
  }

  /**
   * Prevent typing inside sup elements (footnote numbers, hypercite arrows)
   * Sup tags contain generated content that should never be user-editable
   */
  _attachEscapeHandler(): void {
    if (this.supEscapeHandler) {
      this.editableDiv.removeEventListener('beforeinput', this.supEscapeHandler, { capture: true });
    }

    this.supEscapeHandler = supEscapeHandler;

    // Use capture phase to intercept before other handlers
    this.editableDiv.addEventListener('beforeinput', this.supEscapeHandler, { capture: true });
  }

  /**
   * Handle Delete/Backspace at sup boundaries
   * DELETE at position 0 → escape cursor before sup, then delete
   * Backspace at end → confirm footnote/hypercite deletion
   */
  _attachDeleteHandler(): void {
    if (this.supDeleteHandler) {
      this.editableDiv.removeEventListener('beforeinput', this.supDeleteHandler, { capture: true });
    }

    this.supDeleteHandler = supDeleteHandler;

    this.editableDiv.addEventListener('beforeinput', this.supDeleteHandler, { capture: true });
  }

  /**
   * Arrow key navigation to skip across entire hypercite anchors with one key press
   */
  _attachArrowHandler(): void {
    if (this.hyperciteArrowHandler) {
      this.editableDiv.removeEventListener('keydown', this.hyperciteArrowHandler, { capture: true });
    }

    this.hyperciteArrowHandler = hyperciteArrowHandler;

    this.editableDiv.addEventListener('keydown', this.hyperciteArrowHandler, { capture: true });
  }
}
