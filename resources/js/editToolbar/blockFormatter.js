/**
 * Block Formatter for EditToolbar
 *
 * Handles block-level formatting operations:
 * - Heading formatting (H1-H6) - multi-block and cursor-only
 * - Blockquote formatting - wrapping/unwrapping
 * - Code block formatting - wrapping/unwrapping with HTML preservation
 * - Paragraph conversion from headings
 *
 * Cursor-only heading changes use document.execCommand('formatBlock') for
 * simplicity. Complex operations (blockquote/code wrap/unwrap,
 * multi-block heading, pre→heading) use replaceChild + UndoManager.recordFormat().
 */

import {
  findClosestBlockParent,
  getBlockElementsInRange,
  getTextOffsetInElement,
  setCursorAtTextOffset,
  selectAcrossElements,
  findClosestListItem,
  isBlockElement,
} from "./toolbarDOMUtils.js";
import {
  setElementIds,
  findPreviousElementId,
  findNextElementId,
} from "../utilities/IDfunctions.js";
import {
  batchUpdateIndexedDBRecords,
} from "../indexedDB/index.js";

/**
 * BlockFormatter class
 * Handles all block-level formatting operations
 */
export class BlockFormatter {
  constructor(options = {}) {
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
  async formatBlock(type, headingLevel = "h2") {
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

      editableContent.focus();

      const isTextSelected = !this.selectionManager.currentSelection.isCollapsed;
      const parentElement = this.selectionManager.getSelectionParentElement();

      // Check if we're in a list item - delegate to list converter
      const listItem = findClosestListItem(parentElement);
      if (listItem && this.convertListItemToBlockCallback) {
        await this.convertListItemToBlockCallback(listItem, type);
        this.buttonStateManager.updateButtonStates();
        return;
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
        console.error("Error processing save from formatBlock:", error);
      });
    } finally {
      setTimeout(() => {
        this.isFormatting = false;
      }, 100);
    }
  }

  /**
   * After execCommand('formatBlock'), find the new element and reassign
   * its id + data-node-id if the browser dropped them.
   */
  _findAndReassign(oldId, oldNodeId, prevSib, nextSib) {
    // Try by ID first (some browsers preserve it)
    let newEl = oldId ? document.getElementById(oldId) : null;

    if (!newEl) {
      // Walk siblings to find the new element
      newEl = prevSib ? prevSib.nextElementSibling
                      : (nextSib ? nextSib.previousElementSibling : null);
    }

    if (newEl) {
      if (oldId && newEl.id !== oldId) newEl.id = oldId;
      if (oldNodeId && !newEl.getAttribute('data-node-id')) {
        newEl.setAttribute('data-node-id', oldNodeId);
      }
    }

    return newEl;
  }

  /**
   * Content-preserving wrap: converts a paragraph (or any element) into
   * a blockquote or code block, preserving the current innerHTML, id,
   * and data-node-id. Used by wrapBlock and as undo/redo closures.
   * @param {HTMLElement} element - The element to wrap
   * @param {string} type - "blockquote" or "code"
   * @returns {HTMLElement} The new element that replaced the old one
   */
  _contentPreservingWrap(element, type) {
    let newEl;
    if (type === "blockquote") {
      newEl = document.createElement("blockquote");
      let content = element.innerHTML;
      if (content && !content.endsWith("<br>")) content += "<br>";
      newEl.innerHTML = content;
    } else {
      newEl = document.createElement("pre");
      const code = document.createElement("code");
      code.innerHTML = element.innerHTML;
      newEl.appendChild(code);
    }

    newEl.id = element.id;
    if (element.hasAttribute("data-node-id")) {
      newEl.setAttribute("data-node-id", element.getAttribute("data-node-id"));
    }

    element.parentNode.replaceChild(newEl, element);
    return newEl;
  }

  /**
   * Content-preserving unwrap: converts a blockquote or code block back
   * to a paragraph, preserving the current innerHTML, id, and data-node-id.
   * Used by unwrapBlock and as undo/redo closures.
   * @param {HTMLElement} element - The blockquote or pre element to unwrap
   * @param {string} type - "blockquote" or "code"
   * @returns {HTMLElement} The new <p> element that replaced the old one
   */
  _contentPreservingUnwrap(element, type) {
    const p = document.createElement("p");

    if (type === "blockquote") {
      let content = element.innerHTML;
      if (content.endsWith("<br>")) content = content.slice(0, -4);
      p.innerHTML = content || "\u00A0";
    } else {
      const codeEl = element.querySelector("code");
      p.innerHTML = (codeEl ? codeEl.innerHTML : element.innerHTML) || "\u00A0";
    }

    p.id = element.id;
    if (element.hasAttribute("data-node-id")) {
      p.setAttribute("data-node-id", element.getAttribute("data-node-id"));
    }

    element.parentNode.replaceChild(p, element);
    return p;
  }

  /**
   * Handle heading formatting (both multi-block and cursor-only)
   */
  async handleHeadingFormat(isTextSelected, parentElement, headingLevel) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      // Multi-block heading formatting — uses replaceChild + undo stack
      const range = this.selectionManager.currentSelection.getRangeAt(0);
      const affectedBlocks = getBlockElementsInRange(range);

      if (affectedBlocks.length > 0) {
        const recordsToUpdate = [];
        const modifiedElementsForSelection = [];

        for (const block of affectedBlocks) {
          const isHeading = /^H[1-6]$/.test(block.tagName);
          const currentTag = block.tagName.toLowerCase();
          const isCodeBlock = block.tagName === 'PRE';
          let newBlockElement;

          if (isHeading && currentTag === headingLevel) {
            // Same heading level - toggle to paragraph
            newBlockElement = document.createElement("p");
          } else if (isHeading) {
            // Different heading level - convert to new level
            newBlockElement = document.createElement(headingLevel);
          } else {
            // Not a heading - convert to heading
            newBlockElement = document.createElement(headingLevel);
          }

          // Handle code blocks specially - extract text content from <code> element
          if (isCodeBlock) {
            const codeElement = block.querySelector('code');
            newBlockElement.textContent = codeElement ? codeElement.textContent : block.textContent;
          } else {
            newBlockElement.innerHTML = block.innerHTML;
          }
          newBlockElement.id = block.id;

          // Preserve data-node-id attribute if it exists
          if (block.hasAttribute('data-node-id')) {
            newBlockElement.setAttribute('data-node-id', block.getAttribute('data-node-id'));
          }

          // Record content-preserving operation before replaceChild
          if (this.undoManager) {
            const oldTag = block.tagName.toLowerCase();
            const newTag = newBlockElement.tagName.toLowerCase();
            this.undoManager.recordFormat(
              block.id,
              (el) => {
                const r = document.createElement(oldTag);
                if (oldTag === 'pre') {
                  const c = document.createElement('code');
                  c.innerHTML = el.innerHTML;
                  r.appendChild(c);
                } else {
                  r.innerHTML = el.innerHTML;
                }
                r.id = el.id;
                if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
                el.parentNode.replaceChild(r, el);
                return r;
              },
              (el) => {
                const r = document.createElement(newTag);
                if (el.tagName === 'PRE') {
                  const codeEl = el.querySelector('code');
                  r.textContent = codeEl ? codeEl.textContent : el.textContent;
                } else {
                  r.innerHTML = el.innerHTML;
                }
                r.id = el.id;
                if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
                el.parentNode.replaceChild(r, el);
                return r;
              },
              this.currentBookId,
              0
            );
          }
          block.parentNode.replaceChild(newBlockElement, block);

          modifiedElementsForSelection.push({
            id: newBlockElement.id,
            element: newBlockElement,
          });
          recordsToUpdate.push({
            id: newBlockElement.id,
            html: newBlockElement.outerHTML,
          });
        }

        selectAcrossElements(modifiedElementsForSelection);
        this.selectionManager.currentSelection = window.getSelection();

        if (recordsToUpdate.length > 0) {
          batchUpdateIndexedDBRecords(recordsToUpdate);
        }

        return { modifiedElementId, newElement };
      }
    }

    // Cursor-only heading formatting
    const focusNode = this.selectionManager.currentSelection.focusNode;
    let blockParent;

    // If focusNode is already a block element (e.g., empty <p>), use it directly
    // This prevents selecting the parent chunk div when cursor is in an empty paragraph
    if (focusNode.nodeType === Node.ELEMENT_NODE && isBlockElement(focusNode)) {
      blockParent = focusNode;
    } else {
      // Otherwise, find closest block parent
      const cursorFocusParent = focusNode.parentElement;
      blockParent = findClosestBlockParent(cursorFocusParent);
    }

    if (blockParent && /^H[1-6]$/.test(blockParent.tagName)) {
      // Converting from heading to heading or paragraph
      const headingElement = blockParent;
      const currentHeadingLevel = headingElement.tagName.toLowerCase();
      const currentOffset = getTextOffsetInElement(
        headingElement,
        this.selectionManager.currentSelection.focusNode,
        this.selectionManager.currentSelection.focusOffset
      );

      // Save references for ID reassignment after formatBlock
      const oldId = headingElement.id;
      const oldNodeId = headingElement.getAttribute('data-node-id');
      const prevSib = headingElement.previousElementSibling;
      const nextSib = headingElement.nextElementSibling;

      if (currentHeadingLevel === headingLevel) {
        // Same level - convert to paragraph (toggle off) via native formatBlock
        document.execCommand('formatBlock', false, 'p');
        newElement = this._findAndReassign(oldId, oldNodeId, prevSib, nextSib);
        if (newElement) {
          setCursorAtTextOffset(newElement, currentOffset);
          modifiedElementId = newElement.id;
        }
      } else {
        // Different level - convert to new heading level via native formatBlock
        document.execCommand('formatBlock', false, headingLevel);
        newElement = this._findAndReassign(oldId, oldNodeId, prevSib, nextSib);
        if (newElement) {
          setCursorAtTextOffset(newElement, currentOffset);
          modifiedElementId = newElement.id;
        }
      }

      this.selectionManager.currentSelection = window.getSelection();
    } else if (blockParent) {
      // Converting from paragraph (or other block) to heading
      const isCodeBlock = blockParent.tagName === 'PRE';
      const currentOffset = getTextOffsetInElement(
        blockParent,
        this.selectionManager.currentSelection.focusNode,
        this.selectionManager.currentSelection.focusOffset
      );

      if (isCodeBlock) {
        // Code block → heading requires content extraction from <code>,
        // so we use replaceChild + undo stack
        const beforeId = findPreviousElementId(blockParent);
        const afterId = findNextElementId(blockParent);

        const headingElement = document.createElement(headingLevel);
        const codeElement = blockParent.querySelector('code');
        headingElement.textContent = codeElement ? codeElement.textContent : blockParent.textContent;

        const newHeadingId = blockParent.id;
        if (newHeadingId) {
          headingElement.id = newHeadingId;
        } else {
          setElementIds(headingElement, beforeId, afterId, this.currentBookId);
        }

        if (blockParent.hasAttribute('data-node-id')) {
          headingElement.setAttribute('data-node-id', blockParent.getAttribute('data-node-id'));
        }

        if (this.undoManager) {
          const targetLevel = headingLevel;
          this.undoManager.recordFormat(
            blockParent.id,
            (el) => {
              // Undo: heading → pre (restore code block)
              const pre = document.createElement('pre');
              const code = document.createElement('code');
              code.innerHTML = el.innerHTML;
              pre.appendChild(code);
              pre.id = el.id;
              if (el.hasAttribute('data-node-id')) pre.setAttribute('data-node-id', el.getAttribute('data-node-id'));
              el.parentNode.replaceChild(pre, el);
              return pre;
            },
            (el) => {
              // Redo: pre → heading
              const h = document.createElement(targetLevel);
              const codeEl = el.querySelector('code');
              h.textContent = codeEl ? codeEl.textContent : el.textContent;
              h.id = el.id;
              if (el.hasAttribute('data-node-id')) h.setAttribute('data-node-id', el.getAttribute('data-node-id'));
              el.parentNode.replaceChild(h, el);
              return h;
            },
            this.currentBookId,
            currentOffset
          );
        }
        blockParent.parentNode.replaceChild(headingElement, blockParent);

        setCursorAtTextOffset(headingElement, currentOffset);
        modifiedElementId = headingElement.id;
        newElement = headingElement;
      } else {
        // Paragraph → heading via native formatBlock
        const oldId = blockParent.id;
        const oldNodeId = blockParent.getAttribute('data-node-id');
        const prevSib = blockParent.previousElementSibling;
        const nextSib = blockParent.nextElementSibling;

        document.execCommand('formatBlock', false, headingLevel);
        newElement = this._findAndReassign(oldId, oldNodeId, prevSib, nextSib);
        if (newElement) {
          setCursorAtTextOffset(newElement, currentOffset);
          modifiedElementId = newElement.id;
        }
      }

      this.selectionManager.currentSelection = window.getSelection();
    }

    return { modifiedElementId, newElement };
  }

  /**
   * Handle blockquote and code block formatting (wrapping/unwrapping)
   */
  async handleBlockquoteCodeFormat(type, isTextSelected, parentElement) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      // Multi-paragraph wrapping
      const range = this.selectionManager.currentSelection.getRangeAt(0);
      const affectedBlocks = getBlockElementsInRange(range);

      // Only allow paragraph elements for blockquote/code conversion
      const paragraphBlocks = affectedBlocks.filter(block => block.tagName === 'P');

      if (paragraphBlocks.length > 0) {
        // Convert each paragraph to its own block (1:1 conversion)
        // This preserves node_ids so highlights stay connected
        const createdBlocks = [];

        for (const block of paragraphBlocks) {
          const newBlockElement = this._contentPreservingWrap(block, type);

          if (this.undoManager) {
            this.undoManager.recordFormat(
              newBlockElement.id,
              (el) => this._contentPreservingUnwrap(el, type),
              (el) => this._contentPreservingWrap(el, type),
              this.currentBookId,
              0
            );
          }
          createdBlocks.push(newBlockElement);

          // Save (no delete needed since node_id is preserved)
          if (this.currentBookId && this.saveToIndexedDBCallback) {
            await this.saveToIndexedDBCallback(newBlockElement.id, newBlockElement.outerHTML);
          }
        }

        // Select the first new block
        if (createdBlocks.length > 0) {
          this.selectionManager.currentSelection.selectAllChildren(createdBlocks[0]);
          modifiedElementId = createdBlocks[0].id;
          newElement = createdBlocks[0];
        }
      } else {
        // Fallback for selections not in paragraphs
        console.warn("Selection for block format is not within a recognized block.");
        const containingBlock = findClosestBlockParent(parentElement);
        if (containingBlock) {
          const beforeId = findPreviousElementId(containingBlock);
          const afterId = findNextElementId(containingBlock);

          document.execCommand("formatBlock", false, type);

          const newElem =
            document.getElementById(beforeId)?.nextElementSibling ||
            document.getElementById(afterId)?.previousElementSibling;
          if (newElem && this.saveToIndexedDBCallback) {
            setElementIds(newElem, beforeId, afterId, this.currentBookId);
            modifiedElementId = newElem.id;
            newElement = newElem;
            await this.saveToIndexedDBCallback(modifiedElementId, newElement.outerHTML);
          }
        }
      }
    } else {
      // Cursor-only wrapping/unwrapping
      const blockParentToToggle = findClosestBlockParent(parentElement);
      const isBlockquote = blockParentToToggle?.tagName === "BLOCKQUOTE";
      const isCode = blockParentToToggle?.tagName === "PRE";

      // Only allow paragraph wrapping (or unwrapping existing blockquote/code)
      if (blockParentToToggle &&
          blockParentToToggle.tagName !== 'P' &&
          !isBlockquote &&
          !isCode) {
        console.warn(`Cannot convert ${blockParentToToggle.tagName} to ${type} - only paragraphs allowed`);
        return { modifiedElementId, newElement };
      }

      if ((type === "blockquote" && isBlockquote) || (type === "code" && isCode)) {
        // UNWRAPPING
        ({ modifiedElementId, newElement } = await this.unwrapBlock(blockParentToToggle, type));
      } else if (blockParentToToggle) {
        // WRAPPING
        ({ modifiedElementId, newElement } = await this.wrapBlock(blockParentToToggle, type));
      }
    }

    return { modifiedElementId, newElement };
  }

  /**
   * Unwrap a blockquote or code block back to paragraph(s)
   */
  async unwrapBlock(blockToUnwrap, type) {
    const newElement = this._contentPreservingUnwrap(blockToUnwrap, type);
    const modifiedElementId = newElement.id;

    if (this.undoManager) {
      this.undoManager.recordFormat(
        newElement.id,
        (el) => this._contentPreservingWrap(el, type),
        (el) => this._contentPreservingUnwrap(el, type),
        this.currentBookId,
        0
      );
    }

    setCursorAtTextOffset(newElement, 0);

    await batchUpdateIndexedDBRecords([{ id: newElement.id, html: newElement.outerHTML }]);

    return { modifiedElementId, newElement };
  }

  /**
   * Wrap a paragraph in a blockquote or code block
   */
  async wrapBlock(blockParentToToggle, type) {
    const currentOffset = getTextOffsetInElement(
      blockParentToToggle,
      this.selectionManager.currentSelection.focusNode,
      this.selectionManager.currentSelection.focusOffset
    );

    const newElement = this._contentPreservingWrap(blockParentToToggle, type);
    const modifiedElementId = newElement.id;

    if (this.undoManager) {
      this.undoManager.recordFormat(
        newElement.id,
        (el) => this._contentPreservingUnwrap(el, type),
        (el) => this._contentPreservingWrap(el, type),
        this.currentBookId,
        currentOffset
      );
    }

    setCursorAtTextOffset(newElement, currentOffset);

    // Since we preserve node_id, just save the updated content (no delete needed)
    if (this.saveToIndexedDBCallback && newElement.id) {
      await this.saveToIndexedDBCallback(newElement.id, newElement.outerHTML);
    }

    return { modifiedElementId, newElement };
  }

  /**
   * Unwrap selected text from any heading tag (H1-H6) and convert to paragraph
   */
  async unwrapSelectedTextFromHeading() {
    if (!this.selectionManager.currentSelection || this.selectionManager.currentSelection.isCollapsed) {
      console.warn("unwrapSelectedTextFromHeading called with no selection.");
      return null;
    }

    const range = this.selectionManager.currentSelection.getRangeAt(0);
    let headingElement = null;
    let currentElement = this.selectionManager.getSelectionParentElement();

    while (currentElement) {
      if (
        currentElement.nodeType === Node.ELEMENT_NODE &&
        /^H[1-6]$/.test(currentElement.tagName)
      ) {
        headingElement = currentElement;
        break;
      }
      if (
        currentElement.hasAttribute("contenteditable") &&
        currentElement.getAttribute("contenteditable") === "true"
      )
        break;
      if (currentElement === document.body) break;
      currentElement = currentElement.parentNode;
    }

    if (!headingElement) {
      console.warn("unwrapSelectedTextFromHeading: Could not find parent heading element.");
      return null;
    }

    const beforeOriginalId = findPreviousElementId(headingElement);
    const afterOriginalId = findNextElementId(headingElement);

    const pElement = document.createElement("p");
    pElement.innerHTML = headingElement.innerHTML;

    setElementIds(pElement, beforeOriginalId, afterOriginalId, this.currentBookId);

    try {
      // Record content-preserving operation before replaceChild
      if (this.undoManager) {
        const origTag = headingElement.tagName.toLowerCase();
        this.undoManager.recordFormat(
          headingElement.id,
          (el) => {
            // Undo: p → heading
            const h = document.createElement(origTag);
            h.innerHTML = el.innerHTML;
            h.id = el.id;
            if (el.hasAttribute('data-node-id')) h.setAttribute('data-node-id', el.getAttribute('data-node-id'));
            el.parentNode.replaceChild(h, el);
            return h;
          },
          (el) => {
            // Redo: heading → p
            const p = document.createElement('p');
            p.innerHTML = el.innerHTML;
            p.id = el.id;
            if (el.hasAttribute('data-node-id')) p.setAttribute('data-node-id', el.getAttribute('data-node-id'));
            el.parentNode.replaceChild(p, el);
            return p;
          },
          this.currentBookId,
          0
        );
      }
      headingElement.parentNode.replaceChild(pElement, headingElement);
    } catch (domError) {
      console.error("unwrapSelectedTextFromHeading: DOM replacement failed.", domError);
      return null;
    }

    if (this.selectionManager.currentSelection) {
      const newRange = document.createRange();
      newRange.selectNodeContents(pElement);
      this.selectionManager.currentSelection.removeAllRanges();
      this.selectionManager.currentSelection.addRange(newRange);
    }

    console.log(`unwrapSelectedTextFromHeading: New paragraph ID "${pElement.id}"`);

    if (this.currentBookId) {
      if (this.saveToIndexedDBCallback) {
        await this.saveToIndexedDBCallback(pElement.id, pElement.outerHTML);
      }
      if (this.deleteFromIndexedDBCallback) {
        await this.deleteFromIndexedDBCallback(headingElement.id);
      }
    }

    return {
      id: pElement.id,
      element: pElement,
    };
  }

  /**
   * Update the currentBookId (called when book changes)
   */
  setBookId(bookId) {
    this.currentBookId = bookId;
  }

  /**
   * Check if currently formatting
   */
  isCurrentlyFormatting() {
    return this.isFormatting;
  }
}
