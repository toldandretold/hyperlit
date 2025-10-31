/**
 * Text Formatter for EditToolbar
 *
 * Handles inline text formatting:
 * - Bold (with special handling for headings)
 * - Italic
 * - Both selected text and cursor-only cases
 * - Wrapping and unwrapping formatting tags
 */

import {
  hasParentWithTag,
  findParentWithTag,
  findClosestBlockParent,
  getTextOffsetInElement,
  setCursorAtTextOffset,
  getElementsInSelectionRange,
} from "./toolbarDOMUtils.js";

/**
 * TextFormatter class
 * Handles inline text formatting operations
 */
export class TextFormatter {
  constructor(options = {}) {
    this.editableSelector = options.editableSelector || ".main-content[contenteditable='true']";
    this.selectionManager = options.selectionManager || null;
    this.buttonStateManager = options.buttonStateManager || null;
    this.saveToIndexedDBCallback = options.saveToIndexedDBCallback || null;

    this.isFormatting = false;
  }

  /**
   * Format the selected text with the specified style (bold or italic)
   * @param {string} type - "bold" or "italic"
   */
  async formatText(type) {
    console.log("🔧 Format text called:", {
      type: type,
      hasCurrentSelection: !!this.selectionManager.currentSelection,
      hasLastValidRange: !!this.selectionManager.lastValidRange,
      isCollapsed: this.selectionManager.currentSelection?.isCollapsed,
      currentSelectionText: this.selectionManager.currentSelection?.toString(),
    });

    this.isFormatting = true;

    try {
      const editableContent = document.querySelector(this.editableSelector);
      if (!editableContent) return;

      // Use SelectionManager to get working selection
      const { selection: workingSelection, range: workingRange } = this.selectionManager.getWorkingSelection();

      if (!workingSelection || !workingRange) {
        console.warn("❌ No valid selection found - cannot format");
        return;
      }

      this.selectionManager.currentSelection = workingSelection;
      editableContent.focus();

      const affectedElementsBefore = getElementsInSelectionRange(workingRange);
      const originalStates = affectedElementsBefore.map((el) => ({
        id: el.id,
        html: el.outerHTML,
      }));

      const isTextSelected = !this.selectionManager.currentSelection.isCollapsed;
      const parentElement = this.selectionManager.getSelectionParentElement();

      let modifiedElementId = null;
      let newElement = null;

      switch (type) {
        case "bold":
          ({ modifiedElementId, newElement } = await this.handleBoldFormatting(
            isTextSelected,
            parentElement
          ));
          break;

        case "italic":
          ({ modifiedElementId, newElement } = await this.handleItalicFormatting(
            isTextSelected,
            parentElement
          ));
          break;
      }

      this.buttonStateManager.updateButtonStates();

      // Save to IndexedDB
      const handleHistoryAndSave = async () => {
        const affectedElementsAfter = [];
        if (modifiedElementId && document.getElementById(modifiedElementId)) {
          affectedElementsAfter.push({
            id: modifiedElementId,
            html: document.getElementById(modifiedElementId).outerHTML,
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
        console.error("Error processing save from formatText:", error);
      });
    } finally {
      setTimeout(() => {
        this.isFormatting = false;
      }, 100);
    }
  }

  /**
   * Handle bold formatting for both selected text and cursor-only cases
   */
  async handleBoldFormatting(isTextSelected, parentElement) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      // Check if we're in a heading (execCommand gets confused due to CSS bold)
      const blockParent = findClosestBlockParent(parentElement);
      const isInHeading = blockParent && /^H[1-6]$/.test(blockParent.tagName);

      if (isInHeading) {
        // Manual <strong> wrapping for headings
        const range = this.selectionManager.currentSelection.getRangeAt(0);
        const selectedText = range.extractContents();
        const strong = document.createElement("strong");
        strong.appendChild(selectedText);
        range.insertNode(strong);

        // Restore selection
        const newRange = document.createRange();
        newRange.selectNodeContents(strong);
        this.selectionManager.currentSelection.removeAllRanges();
        this.selectionManager.currentSelection.addRange(newRange);

        modifiedElementId = blockParent.id;
        newElement = blockParent;
      } else {
        // Use native execCommand for paragraphs/blockquotes
        document.execCommand("bold", false, null);
        const parentAfterBold = this.selectionManager.getSelectionParentElement();
        const blockParentAfter = findClosestBlockParent(parentAfterBold);
        if (blockParentAfter && blockParentAfter.id) {
          modifiedElementId = blockParentAfter.id;
          newElement = blockParentAfter;
        }
      }
    } else {
      // Cursor-only bold (no selection)
      const currentOffset = getTextOffsetInElement(
        parentElement,
        this.selectionManager.currentSelection.focusNode,
        this.selectionManager.currentSelection.focusOffset
      );

      const blockParent = findClosestBlockParent(parentElement);
      const isInHeading = blockParent && /^H[1-6]$/.test(blockParent.tagName);

      if (
        hasParentWithTag(parentElement, "STRONG") ||
        hasParentWithTag(parentElement, "B")
      ) {
        // UNWRAP: Remove existing bold
        const boldElement =
          findParentWithTag(parentElement, "STRONG") ||
          findParentWithTag(parentElement, "B");
        if (boldElement) {
          const newTextNode = document.createTextNode(boldElement.textContent);
          const parentNode = boldElement.parentNode;
          parentNode.replaceChild(newTextNode, boldElement);
          setCursorAtTextOffset(parentNode, currentOffset);
          const blockParentAfter = findClosestBlockParent(parentNode);
          if (blockParentAfter && blockParentAfter.id) {
            modifiedElementId = blockParentAfter.id;
            newElement = blockParentAfter;
          }
        }
      } else {
        // WRAP: Add bold to current text node
        let node = this.selectionManager.currentSelection.focusNode;
        if (node.nodeType !== Node.TEXT_NODE) {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          node = walker.nextNode();
        }

        if (node && node.nodeType === Node.TEXT_NODE) {
          if (isInHeading) {
            // Manual <strong> wrapping for headings
            const range = document.createRange();
            range.selectNodeContents(node);
            const selectedText = range.extractContents();
            const strong = document.createElement("strong");
            strong.appendChild(selectedText);
            range.insertNode(strong);

            setCursorAtTextOffset(strong, currentOffset);
            modifiedElementId = blockParent.id;
            newElement = blockParent;
          } else {
            // Use execCommand for paragraphs
            const range = document.createRange();
            range.selectNodeContents(node);
            this.selectionManager.currentSelection.removeAllRanges();
            this.selectionManager.currentSelection.addRange(range);
            document.execCommand("bold", false, null);
            const newBoldNode =
              findParentWithTag(node.parentNode, "STRONG") ||
              findParentWithTag(node.parentNode, "B");
            if (newBoldNode) {
              setCursorAtTextOffset(newBoldNode, currentOffset);
              const blockParentAfter = findClosestBlockParent(newBoldNode);
              if (blockParentAfter && blockParentAfter.id) {
                modifiedElementId = blockParentAfter.id;
                newElement = blockParentAfter;
              }
            }
          }
        }
      }
    }

    return { modifiedElementId, newElement };
  }

  /**
   * Handle italic formatting for both selected text and cursor-only cases
   */
  async handleItalicFormatting(isTextSelected, parentElement) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      document.execCommand("italic", false, null);
      const parentAfterItalic = this.selectionManager.getSelectionParentElement();
      const blockParent = findClosestBlockParent(parentAfterItalic);
      if (blockParent && blockParent.id) {
        modifiedElementId = blockParent.id;
        newElement = blockParent;
      }
    } else {
      // Cursor-only italic (no selection)
      const currentOffset = getTextOffsetInElement(
        parentElement,
        this.selectionManager.currentSelection.focusNode,
        this.selectionManager.currentSelection.focusOffset
      );

      if (
        hasParentWithTag(parentElement, "EM") ||
        hasParentWithTag(parentElement, "I")
      ) {
        // UNWRAP: Remove existing italic
        const italicElement =
          findParentWithTag(parentElement, "EM") ||
          findParentWithTag(parentElement, "I");
        if (italicElement) {
          const newTextNode = document.createTextNode(italicElement.textContent);
          const parentNode = italicElement.parentNode;
          parentNode.replaceChild(newTextNode, italicElement);
          setCursorAtTextOffset(parentNode, currentOffset);
          const blockParent = findClosestBlockParent(parentNode);
          if (blockParent && blockParent.id) {
            modifiedElementId = blockParent.id;
            newElement = blockParent;
          }
        }
      } else {
        // WRAP: Add italic to current text node
        let node = this.selectionManager.currentSelection.focusNode;
        if (node.nodeType !== Node.TEXT_NODE) {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          node = walker.nextNode();
        }

        if (node && node.nodeType === Node.TEXT_NODE) {
          const range = document.createRange();
          range.selectNodeContents(node);
          this.selectionManager.currentSelection.removeAllRanges();
          this.selectionManager.currentSelection.addRange(range);
          document.execCommand("italic", false, null);
          const newItalicNode =
            findParentWithTag(node.parentNode, "EM") ||
            findParentWithTag(node.parentNode, "I");
          if (newItalicNode) {
            setCursorAtTextOffset(newItalicNode, currentOffset);
            const blockParent = findClosestBlockParent(newItalicNode);
            if (blockParent && blockParent.id) {
              modifiedElementId = blockParent.id;
              newElement = blockParent;
            }
          }
        }
      }
    }

    return { modifiedElementId, newElement };
  }

  /**
   * Check if currently formatting
   */
  isCurrentlyFormatting() {
    return this.isFormatting;
  }
}
