/**
 * Block Formatter for EditToolbar
 *
 * Handles block-level formatting operations:
 * - Heading formatting (H1-H6) - multi-block and cursor-only
 * - Blockquote formatting - wrapping/unwrapping
 * - Code block formatting - wrapping/unwrapping with HTML preservation
 * - Paragraph conversion from headings
 *
 * All heading changes (cursor-only and multi-block) use replaceChild +
 * UndoManager.recordFormat(). Complex operations (blockquote/code wrap/unwrap)
 * also use replaceChild + UndoManager.recordFormat().
 */

import {
  findClosestBlockParent,
  getBlockElementsInRange,
  getTextOffsetInElement,
  setCursorAtTextOffset,
  selectAcrossElements,
  findClosestListItem,
  isBlockElement,
} from "./toolbarDOMUtils";
import {
  setElementIds,
  findPreviousElementId,
  findNextElementId,
} from "../utilities/IDfunctions";
import {
  batchUpdateIndexedDBRecords,
} from "../indexedDB/index.js";
import * as headingCmd from "./blockFormat/headingFormat";
import * as bqCmd from "./blockFormat/blockquoteCodeFormat";
import * as listCmd from "./blockFormat/listFormat";

/**
 * BlockFormatter class
 * Handles all block-level formatting operations
 */
export class BlockFormatter {
  editableSelector: string;
  currentBookId: any;
  selectionManager: any;
  buttonStateManager: any;
  saveToIndexedDBCallback: any;
  deleteFromIndexedDBCallback: any;
  convertListItemToBlockCallback: any;
  undoManager: any;
  isFormatting: boolean = false;

  constructor(options: any = {}) {
    this.editableSelector = options.editableSelector || ".main-content[contenteditable='true']";
    this.currentBookId = options.currentBookId || null;
    this.selectionManager = options.selectionManager || null;
    this.buttonStateManager = options.buttonStateManager || null;
    this.saveToIndexedDBCallback = options.saveToIndexedDBCallback || null;
    this.deleteFromIndexedDBCallback = options.deleteFromIndexedDBCallback || null;
    this.convertListItemToBlockCallback = options.convertListItemToBlockCallback || null;
    this.undoManager = options.undoManager || null;

    this.isFormatting = false;
  }

  /**
   * Format a block element (heading, blockquote, or code)
   * @param {string} type - "heading", "blockquote", or "code"
   * @param {string} headingLevel - "h1" through "h6" (only for heading type)
   */
  async formatBlock(type: any, headingLevel = "h2") {
    console.log("🔧 Format block called:", {
      type: type,
      headingLevel: headingLevel,
      hasCurrentSelection: !!this.selectionManager.currentSelection,
      hasLastValidRange: !!this.selectionManager.lastValidRange,
      isCollapsed: this.selectionManager.currentSelection?.isCollapsed,
      currentSelectionText: this.selectionManager.currentSelection?.toString(),
    });

    this.isFormatting = true;

    try {
      // Get the working selection first so we can derive the editable container from it.
      // This handles sub-book editing where the active element is not .main-content.
      const { selection: workingSelection, range: workingRange } = this.selectionManager.getWorkingSelection();

      if (!workingSelection || !workingRange) {
        console.warn("❌ No valid selection found - cannot format");
        return;
      }

      this.selectionManager.currentSelection = workingSelection;

      // Find the nearest contenteditable ancestor of the selection, falling back to the
      // main-content selector for backwards compatibility.
      const anchor = workingRange.commonAncestorContainer;
      const anchorEl = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
      const editableContent = anchorEl.closest('[contenteditable="true"]')
        || document.querySelector(this.editableSelector);
      if (!editableContent) return;

      const isTextSelected = !this.selectionManager.currentSelection.isCollapsed;
      const parentElement = this.selectionManager.getSelectionParentElement();

      // Check if we're in a list item
      // For blockquote/code: convert entire list to a single block (items joined by <br>)
      // For heading: delegate to list converter (splits list — each item becomes heading)
      const listItem = findClosestListItem(parentElement);
      if (listItem && type !== "list" && type !== "remove-list") {
        const parentList = listItem.parentElement;

        if (type === "blockquote" || type === "code") {
          // List → blockquote/code: convert entire list to a single block
          // with items joined by <br> (blockquote) or newlines (code)
          const result = await this.handleListToBlock(parentList, listItem, type);
          this.buttonStateManager.updateButtonStates();

          // Re-focus after cursor positioned
          if (!editableContent.contains(document.activeElement)) {
            editableContent.focus({ preventScroll: true });
          }

          // Save to IndexedDB
          if (result.modifiedElementId && result.newElement && this.saveToIndexedDBCallback) {
            await this.saveToIndexedDBCallback(result.modifiedElementId, result.newElement.outerHTML);
          }
          return;
        } else if (this.convertListItemToBlockCallback) {
          // Heading: delegate to list converter (splits list — each item becomes heading)
          await this.convertListItemToBlockCallback(listItem, type);
          this.buttonStateManager.updateButtonStates();
          return;
        }
      }

      let modifiedElementId = null;
      let newElement = null;

      switch (type) {
        case "heading":
          ({ modifiedElementId, newElement } = await this.handleHeadingFormat(
            isTextSelected,
            parentElement,
            headingLevel
          ));
          break;

        case "blockquote":
        case "code":
          ({ modifiedElementId, newElement } = await this.handleBlockquoteCodeFormat(
            type,
            isTextSelected,
            parentElement
          ));
          break;

        case "list":
          ({ modifiedElementId, newElement } = await this.handleListFormat(
            headingLevel, // repurposed as listType: "ul" or "ol"
            parentElement,
            isTextSelected
          ));
          break;

        case "remove-list":
          ({ modifiedElementId, newElement } = await this.handleRemoveList(parentElement));
          break;
      }

      // Re-focus the editable AFTER cursor has been positioned by the handler.
      // This avoids the flash-at-position-0 caused by focusing before the DOM swap,
      // while still ensuring the caret is visible after replaceChild.
      if (!editableContent.contains(document.activeElement)) {
        // Use preventScroll to avoid the page jumping
        editableContent.focus({ preventScroll: true });
      }

      this.buttonStateManager.updateButtonStates();

      // Save to IndexedDB
      const handleHistoryAndSave = async () => {
        const affectedElementsAfter = [];
        if (modifiedElementId && document.getElementById(modifiedElementId)) {
          affectedElementsAfter.push({
            id: modifiedElementId,
            html: document.getElementById(modifiedElementId)!.outerHTML,
          });
        } else if (modifiedElementId && newElement) {
          affectedElementsAfter.push({
            id: newElement.id,
            html: newElement.outerHTML,
          });
        }

        if (modifiedElementId && newElement && this.saveToIndexedDBCallback) {
          const updatedElement = document.getElementById(modifiedElementId);
          if (updatedElement) {
            await this.saveToIndexedDBCallback(modifiedElementId, updatedElement.outerHTML);
          } else {
            await this.saveToIndexedDBCallback(modifiedElementId, newElement.outerHTML);
          }
        }
      };

      handleHistoryAndSave().catch((error) => {
        console.error("Error processing save from formatBlock:", error);
      });
    } finally {
      setTimeout(() => {
        this.isFormatting = false;
      }, 100);
    }
  }

  /**
   * Content-preserving wrap: converts a paragraph (or any element) into
   * a blockquote or code block, preserving the current innerHTML, id,
   * and data-node-id. Used by wrapBlock and as undo/redo closures.
   * @param {HTMLElement} element - The element to wrap
   * @param {string} type - "blockquote" or "code"
   * @returns {HTMLElement} The new element that replaced the old one
   */
  _contentPreservingWrap(element: any, type: any) {
    return bqCmd._contentPreservingWrap(this, element, type);
  }

  /**
   * Content-preserving unwrap: converts a blockquote or code block back
   * to a paragraph, preserving the current innerHTML, id, and data-node-id.
   * Used by unwrapBlock and as undo/redo closures.
   * @param {HTMLElement} element - The blockquote or pre element to unwrap
   * @param {string} type - "blockquote" or "code"
   * @returns {HTMLElement} The new <p> element that replaced the old one
   */
  _contentPreservingUnwrap(element: any, type: any) {
    return bqCmd._contentPreservingUnwrap(this, element, type);
  }

  /**
   * Handle heading formatting (both multi-block and cursor-only)
   */
  async handleHeadingFormat(isTextSelected: any, parentElement: any, headingLevel: any) {
    return headingCmd.handleHeadingFormat(this, isTextSelected, parentElement, headingLevel);
  }

  /**
   * Handle blockquote and code block formatting (wrapping/unwrapping)
   */
  async handleBlockquoteCodeFormat(type: any, isTextSelected: any, parentElement: any) {
    return bqCmd.handleBlockquoteCodeFormat(this, type, isTextSelected, parentElement);
  }

  /**
   * Unwrap a blockquote or code block back to paragraph(s)
   */
  async unwrapBlock(blockToUnwrap: any, type: any) {
    return bqCmd.unwrapBlock(this, blockToUnwrap, type);
  }

  /**
   * Wrap a paragraph in a blockquote or code block
   */
  async wrapBlock(blockParentToToggle: any, type: any) {
    return bqCmd.wrapBlock(this, blockParentToToggle, type);
  }

  /**
   * Unwrap selected text from any heading tag (H1-H6) and convert to paragraph
   */
  async unwrapSelectedTextFromHeading() {
    return headingCmd.unwrapSelectedTextFromHeading(this);
  }

  /**
   * Handle list formatting — wrap paragraph(s) in <ul> or <ol>
   * @param {string} listType - "ul" or "ol"
   * @param {HTMLElement} parentElement - the element containing the cursor
   * @param {boolean} isTextSelected - whether text is selected across blocks
   */
  async handleListFormat(listType: any, parentElement: any, isTextSelected = false) {
    return listCmd.handleListFormat(this, listType, parentElement, isTextSelected);
  }

  /**
   * Handle converting a list to a blockquote or code block.
   * Joins all <li> items with <br> (blockquote) or newlines (code).
   * Records proper undo so list ↔ block round-trips correctly.
   * @param {HTMLElement} listEl - The UL/OL element
   * @param {HTMLElement} listItem - The LI element the cursor is in
   * @param {string} blockType - "blockquote" or "code"
   */
  async handleListToBlock(listEl: any, listItem: any, blockType: any) {
    return listCmd.handleListToBlock(this, listEl, listItem, blockType);
  }

  /**
   * Merge multiple paragraphs into a single list.
   * First paragraph's ID/node_id is inherited by the list; extras are deleted.
   * @param {HTMLElement[]} paragraphs - Array of <p> elements to merge
   * @param {string} listType - "ul" or "ol"
   */
  async _mergeBlocksIntoList(paragraphs: any, listType: any) {
    return listCmd._mergeBlocksIntoList(this, paragraphs, listType);
  }

  /**
   * Merge multiple paragraphs into a single blockquote (items joined by <br>).
   * First paragraph's ID/node_id is inherited; extras are deleted.
   * @param {HTMLElement[]} paragraphs - Array of <p> elements to merge
   */
  async _mergeBlocksIntoBlockquote(paragraphs: any) {
    return bqCmd._mergeBlocksIntoBlockquote(this, paragraphs);
  }

  /**
   * Handle removing a list — unwrap list items back to paragraphs
   * @param {HTMLElement} parentElement - the element containing the cursor
   */
  async handleRemoveList(parentElement: any) {
    return listCmd.handleRemoveList(this, parentElement);
  }

  /**
   * Update the currentBookId (called when book changes)
   */
  setBookId(bookId: any) {
    this.currentBookId = bookId;
  }

  /**
   * Check if currently formatting
   */
  isCurrentlyFormatting() {
    return this.isFormatting;
  }
}
