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

      // Determine target tag: toggle to <p> if same level, otherwise new heading
      const targetTag = (currentHeadingLevel === headingLevel) ? 'p' : headingLevel;

      // Create replacement element, preserving content and identity
      const newEl = document.createElement(targetTag);
      newEl.innerHTML = headingElement.innerHTML;
      newEl.id = headingElement.id;
      if (headingElement.hasAttribute('data-node-id')) {
        newEl.setAttribute('data-node-id', headingElement.getAttribute('data-node-id'));
      }

      // Record for undo/redo
      if (this.undoManager) {
        const oldTag = currentHeadingLevel;
        const newTag = targetTag;
        this.undoManager.recordFormat(
          headingElement.id,
          (el) => {
            const r = document.createElement(oldTag);
            r.innerHTML = el.innerHTML;
            r.id = el.id;
            if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
            el.parentNode.replaceChild(r, el);
            return r;
          },
          (el) => {
            const r = document.createElement(newTag);
            r.innerHTML = el.innerHTML;
            r.id = el.id;
            if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
            el.parentNode.replaceChild(r, el);
            return r;
          },
          this.currentBookId,
          currentOffset
        );
      }

      headingElement.parentNode.replaceChild(newEl, headingElement);
      setCursorAtTextOffset(newEl, currentOffset);
      modifiedElementId = newEl.id;
      newElement = newEl;

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
        // Paragraph → heading via replaceChild
        const newEl = document.createElement(headingLevel);
        newEl.innerHTML = blockParent.innerHTML;
        newEl.id = blockParent.id;
        if (blockParent.hasAttribute('data-node-id')) {
          newEl.setAttribute('data-node-id', blockParent.getAttribute('data-node-id'));
        }

        // Record for undo/redo
        if (this.undoManager) {
          const oldTag = blockParent.tagName.toLowerCase();
          const newTag = headingLevel;
          this.undoManager.recordFormat(
            blockParent.id,
            (el) => {
              const r = document.createElement(oldTag);
              r.innerHTML = el.innerHTML;
              r.id = el.id;
              if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
              el.parentNode.replaceChild(r, el);
              return r;
            },
            (el) => {
              const r = document.createElement(newTag);
              r.innerHTML = el.innerHTML;
              r.id = el.id;
              if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
              el.parentNode.replaceChild(r, el);
              return r;
            },
            this.currentBookId,
            currentOffset
          );
        }

        blockParent.parentNode.replaceChild(newEl, blockParent);
        setCursorAtTextOffset(newEl, currentOffset);
        modifiedElementId = newEl.id;
        newElement = newEl;
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

      if (paragraphBlocks.length > 1 && type === "blockquote") {
        // Multiple paragraphs → merge into a single blockquote (items joined by <br>)
        return await this._mergeBlocksIntoBlockquote(paragraphBlocks);
      } else if (paragraphBlocks.length > 0) {
        // Single paragraph or code: convert each paragraph to its own block (1:1)
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
    // Capture cursor offset before DOM replacement
    const currentOffset = getTextOffsetInElement(
      blockToUnwrap,
      this.selectionManager.currentSelection.focusNode,
      this.selectionManager.currentSelection.focusOffset
    );

    const newElement = this._contentPreservingUnwrap(blockToUnwrap, type);
    const modifiedElementId = newElement.id;

    if (this.undoManager) {
      this.undoManager.recordFormat(
        newElement.id,
        (el) => this._contentPreservingWrap(el, type),
        (el) => this._contentPreservingUnwrap(el, type),
        this.currentBookId,
        currentOffset
      );
    }

    setCursorAtTextOffset(newElement, currentOffset);

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
   * Handle list formatting — wrap paragraph(s) in <ul> or <ol>
   * @param {string} listType - "ul" or "ol"
   * @param {HTMLElement} parentElement - the element containing the cursor
   * @param {boolean} isTextSelected - whether text is selected across blocks
   */
  async handleListFormat(listType, parentElement, isTextSelected = false) {
    let modifiedElementId = null;
    let newElement = null;

    // Capture cursor offset before any DOM changes
    const sel = this.selectionManager.currentSelection;
    const focusNode = sel.focusNode;
    const focusOffset = sel.focusOffset;

    // Multi-paragraph selection → merge into a single list
    if (isTextSelected) {
      const range = sel.getRangeAt(0);
      const affectedBlocks = getBlockElementsInRange(range);
      const paragraphBlocks = affectedBlocks.filter(block => block.tagName === 'P');

      if (paragraphBlocks.length > 1) {
        return await this._mergeBlocksIntoList(paragraphBlocks, listType);
      }
    }

    // Check if already inside a list — swap UL↔OL in place
    const listItem = findClosestListItem(parentElement);
    if (listItem) {
      let listEl = listItem.parentElement;
      if (listEl && (listEl.tagName === "UL" || listEl.tagName === "OL")) {
        const currentTag = listEl.tagName.toLowerCase();
        if (currentTag === listType) {
          // Already the same list type — nothing to do
          return { modifiedElementId, newElement };
        }

        const currentOffset = getTextOffsetInElement(listItem, focusNode, focusOffset);

        // Swap list tag: create new list, move all children over
        const newListEl = document.createElement(listType);
        newListEl.id = listEl.id;
        if (listEl.hasAttribute("data-node-id")) {
          newListEl.setAttribute("data-node-id", listEl.getAttribute("data-node-id"));
        }
        while (listEl.firstChild) {
          newListEl.appendChild(listEl.firstChild);
        }

        // Record for undo/redo
        if (this.undoManager) {
          const oldTag = currentTag;
          const newTag = listType;
          this.undoManager.recordFormat(
            listEl.id,
            (el) => {
              const r = document.createElement(oldTag);
              r.id = el.id;
              if (el.hasAttribute("data-node-id")) r.setAttribute("data-node-id", el.getAttribute("data-node-id"));
              while (el.firstChild) r.appendChild(el.firstChild);
              el.parentNode.replaceChild(r, el);
              return r;
            },
            (el) => {
              const r = document.createElement(newTag);
              r.id = el.id;
              if (el.hasAttribute("data-node-id")) r.setAttribute("data-node-id", el.getAttribute("data-node-id"));
              while (el.firstChild) r.appendChild(el.firstChild);
              el.parentNode.replaceChild(r, el);
              return r;
            },
            this.currentBookId,
            currentOffset
          );
        }

        listEl.parentNode.replaceChild(newListEl, listEl);

        // Restore cursor inside the same li (it was moved, not recreated)
        setCursorAtTextOffset(listItem, currentOffset);

        modifiedElementId = newListEl.id;
        newElement = newListEl;
        this.selectionManager.currentSelection = window.getSelection();
        return { modifiedElementId, newElement };
      }
    }

    let blockParent = findClosestBlockParent(parentElement);
    let fromBlockquote = false;

    // If cursor is in a blockquote, convert directly to list (single undo step)
    // Splits on <br> to restore multiple list items
    if (blockParent && blockParent.tagName === 'BLOCKQUOTE') {
      fromBlockquote = true;
      const currentOffset = getTextOffsetInElement(blockParent, focusNode, focusOffset);

      // Extract content from blockquote (strip trailing <br> that blockquote adds)
      let content = blockParent.innerHTML;
      if (content.endsWith("<br>")) content = content.slice(0, -4);

      // Split on <br> to create multiple list items
      const parts = content.split(/<br\s*\/?>/i).filter(part => part.trim() !== "");

      // Build list element with one <li> per part
      const listEl = document.createElement(listType);
      for (const part of parts) {
        const li = document.createElement("li");
        li.innerHTML = part;
        listEl.appendChild(li);
      }

      listEl.id = blockParent.id;
      if (blockParent.hasAttribute("data-node-id")) {
        listEl.setAttribute("data-node-id", blockParent.getAttribute("data-node-id"));
      }

      // Snapshot blockquote HTML for undo
      const originalBlockquoteHTML = blockParent.outerHTML;

      // Record single undo entry: list ↔ blockquote (no intermediate paragraph)
      if (this.undoManager) {
        this.undoManager.recordFormat(
          blockParent.id,
          // Undo: list → blockquote (restore original)
          (el) => {
            const temp = document.createElement("div");
            temp.innerHTML = originalBlockquoteHTML;
            const restored = temp.firstElementChild;
            el.parentNode.replaceChild(restored, el);
            return restored;
          },
          // Redo: blockquote → list (split on <br>)
          (el) => {
            let c = el.innerHTML;
            if (c.endsWith("<br>")) c = c.slice(0, -4);
            const ps = c.split(/<br\s*\/?>/i).filter(p => p.trim() !== "");
            const list = document.createElement(listType);
            for (const p of ps) {
              const newLi = document.createElement("li");
              newLi.innerHTML = p;
              list.appendChild(newLi);
            }
            list.id = el.id;
            if (el.hasAttribute("data-node-id")) list.setAttribute("data-node-id", el.getAttribute("data-node-id"));
            el.parentNode.replaceChild(list, el);
            return list;
          },
          this.currentBookId,
          currentOffset
        );
      }

      blockParent.parentNode.replaceChild(listEl, blockParent);
      // Place cursor in the first <li>
      const firstLi = listEl.querySelector("li");
      if (firstLi) setCursorAtTextOffset(firstLi, Math.min(currentOffset, firstLi.textContent.length));

      modifiedElementId = listEl.id;
      newElement = listEl;
      this.selectionManager.currentSelection = window.getSelection();
      return { modifiedElementId, newElement };
    }

    if (!blockParent || blockParent.tagName !== 'P') {
      console.warn(`Cannot convert ${blockParent?.tagName || 'unknown'} to list — only paragraphs allowed`);
      return { modifiedElementId, newElement };
    }

    const currentOffset = getTextOffsetInElement(blockParent, focusNode, focusOffset);

    // Build list element
    const listEl = document.createElement(listType);
    const li = document.createElement("li");
    li.innerHTML = blockParent.innerHTML;
    listEl.appendChild(li);

    // Transfer identity from the paragraph to the list
    listEl.id = blockParent.id;
    if (blockParent.hasAttribute("data-node-id")) {
      listEl.setAttribute("data-node-id", blockParent.getAttribute("data-node-id"));
    }

    // Record for undo/redo
    if (this.undoManager) {
      this.undoManager.recordFormat(
        blockParent.id,
        // Undo: list → paragraph
        (el) => {
          const p = document.createElement("p");
          const firstLi = el.querySelector("li");
          p.innerHTML = firstLi ? firstLi.innerHTML : el.innerHTML;
          p.id = el.id;
          if (el.hasAttribute("data-node-id")) p.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          el.parentNode.replaceChild(p, el);
          return p;
        },
        // Redo: paragraph → list
        (el) => {
          const list = document.createElement(listType);
          const newLi = document.createElement("li");
          newLi.innerHTML = el.innerHTML;
          list.appendChild(newLi);
          list.id = el.id;
          if (el.hasAttribute("data-node-id")) list.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          el.parentNode.replaceChild(list, el);
          return list;
        },
        this.currentBookId,
        currentOffset
      );
    }

    blockParent.parentNode.replaceChild(listEl, blockParent);

    // Place cursor inside the <li>
    setCursorAtTextOffset(li, currentOffset);

    modifiedElementId = listEl.id;
    newElement = listEl;

    this.selectionManager.currentSelection = window.getSelection();

    return { modifiedElementId, newElement };
  }

  /**
   * Handle converting a list to a blockquote or code block.
   * Joins all <li> items with <br> (blockquote) or newlines (code).
   * Records proper undo so list ↔ block round-trips correctly.
   * @param {HTMLElement} listEl - The UL/OL element
   * @param {HTMLElement} listItem - The LI element the cursor is in
   * @param {string} blockType - "blockquote" or "code"
   */
  async handleListToBlock(listEl, listItem, blockType) {
    let modifiedElementId = null;
    let newElement = null;

    // Capture cursor offset before DOM changes
    const sel = this.selectionManager.currentSelection;
    let currentOffset = 0;
    if (sel && sel.focusNode) {
      try {
        currentOffset = getTextOffsetInElement(listItem, sel.focusNode, sel.focusOffset);
      } catch (e) { /* ignore */ }
    }

    const allItems = Array.from(listEl.querySelectorAll(":scope > li"));

    // Snapshot original list HTML for undo
    const originalListHTML = listEl.outerHTML;

    // Build the target block element from ALL list items
    let newBlock;
    if (blockType === "blockquote") {
      newBlock = document.createElement("blockquote");
      const content = allItems.map(li => li.innerHTML).join("<br>");
      newBlock.innerHTML = content + "<br>";
    } else {
      newBlock = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = allItems.map(li => li.textContent.trim()).join("\n");
      newBlock.appendChild(code);
    }

    // Transfer identity
    newBlock.id = listEl.id;
    if (listEl.hasAttribute("data-node-id")) {
      newBlock.setAttribute("data-node-id", listEl.getAttribute("data-node-id"));
    }

    // Record undo: block ↔ list (single step)
    if (this.undoManager) {
      this.undoManager.recordFormat(
        listEl.id,
        // Undo: blockquote/code → list (restore original)
        (el) => {
          const temp = document.createElement("div");
          temp.innerHTML = originalListHTML;
          const restored = temp.firstElementChild;
          el.parentNode.replaceChild(restored, el);
          return restored;
        },
        // Redo: list → blockquote/code
        (el) => {
          let block;
          const items = Array.from(el.querySelectorAll(":scope > li"));
          if (blockType === "blockquote") {
            block = document.createElement("blockquote");
            const c = items.map(li => li.innerHTML).join("<br>");
            block.innerHTML = c + "<br>";
          } else {
            block = document.createElement("pre");
            const code = document.createElement("code");
            code.textContent = items.map(li => li.textContent.trim()).join("\n");
            block.appendChild(code);
          }
          block.id = el.id;
          if (el.hasAttribute("data-node-id")) block.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          el.parentNode.replaceChild(block, el);
          return block;
        },
        this.currentBookId,
        currentOffset
      );
    }

    listEl.parentNode.replaceChild(newBlock, listEl);
    setCursorAtTextOffset(newBlock, currentOffset);

    modifiedElementId = newBlock.id;
    newElement = newBlock;
    this.selectionManager.currentSelection = window.getSelection();

    return { modifiedElementId, newElement };
  }

  /**
   * Merge multiple paragraphs into a single list.
   * First paragraph's ID/node_id is inherited by the list; extras are deleted.
   * @param {HTMLElement[]} paragraphs - Array of <p> elements to merge
   * @param {string} listType - "ul" or "ol"
   */
  async _mergeBlocksIntoList(paragraphs, listType) {
    const listEl = document.createElement(listType);

    for (const p of paragraphs) {
      const li = document.createElement("li");
      li.innerHTML = p.innerHTML;
      listEl.appendChild(li);
    }

    // Inherit identity from first paragraph
    const firstP = paragraphs[0];
    listEl.id = firstP.id;
    if (firstP.hasAttribute("data-node-id")) {
      listEl.setAttribute("data-node-id", firstP.getAttribute("data-node-id"));
    }

    // Snapshot for undo
    const originalParagraphsHTML = paragraphs.map(p => p.outerHTML);
    const extraIds = paragraphs.slice(1).map(p => p.id);

    // Record undo
    if (this.undoManager) {
      this.undoManager.recordFormat(
        firstP.id,
        // Undo: list → paragraphs (restore originals)
        (el) => {
          const parent = el.parentNode;
          // Insert all paragraphs before the list element, then remove it
          for (const html of originalParagraphsHTML) {
            const temp = document.createElement("div");
            temp.innerHTML = html;
            parent.insertBefore(temp.firstElementChild, el);
          }
          parent.removeChild(el);
          return document.getElementById(firstP.id);
        },
        // Redo: paragraphs → list
        (el) => {
          const parent = el.parentNode;
          const list = document.createElement(listType);
          // Gather all the paragraphs (first el + extras by ID)
          const allParas = [el, ...extraIds.map(id => document.getElementById(id)).filter(Boolean)];
          for (const p of allParas) {
            const li = document.createElement("li");
            li.innerHTML = p.innerHTML;
            list.appendChild(li);
          }
          list.id = el.id;
          if (el.hasAttribute("data-node-id")) list.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          // Remove extras
          for (const p of allParas.slice(1)) {
            p.remove();
          }
          parent.replaceChild(list, el);
          return list;
        },
        this.currentBookId,
        0
      );
    }

    // Insert list where first paragraph was, remove all paragraphs
    firstP.parentNode.insertBefore(listEl, firstP);
    for (const p of paragraphs) {
      p.remove();
    }

    // Save list to IndexedDB
    if (this.saveToIndexedDBCallback) {
      await this.saveToIndexedDBCallback(listEl.id, listEl.outerHTML);
    }

    // Delete extra paragraphs from IndexedDB
    if (this.deleteFromIndexedDBCallback) {
      for (const id of extraIds) {
        await this.deleteFromIndexedDBCallback(id);
      }
    }

    this.selectionManager.currentSelection = window.getSelection();
    const firstLi = listEl.querySelector("li");
    if (firstLi) setCursorAtTextOffset(firstLi, 0);

    return { modifiedElementId: listEl.id, newElement: listEl };
  }

  /**
   * Merge multiple paragraphs into a single blockquote (items joined by <br>).
   * First paragraph's ID/node_id is inherited; extras are deleted.
   * @param {HTMLElement[]} paragraphs - Array of <p> elements to merge
   */
  async _mergeBlocksIntoBlockquote(paragraphs) {
    const bq = document.createElement("blockquote");
    const content = paragraphs.map(p => p.innerHTML).join("<br>");
    bq.innerHTML = content + "<br>";

    // Inherit identity from first paragraph
    const firstP = paragraphs[0];
    bq.id = firstP.id;
    if (firstP.hasAttribute("data-node-id")) {
      bq.setAttribute("data-node-id", firstP.getAttribute("data-node-id"));
    }

    // Snapshot for undo
    const originalParagraphsHTML = paragraphs.map(p => p.outerHTML);
    const extraIds = paragraphs.slice(1).map(p => p.id);

    // Record undo
    if (this.undoManager) {
      this.undoManager.recordFormat(
        firstP.id,
        // Undo: blockquote → paragraphs (restore originals)
        (el) => {
          const parent = el.parentNode;
          // Insert all paragraphs before the blockquote, then remove it
          for (const html of originalParagraphsHTML) {
            const temp = document.createElement("div");
            temp.innerHTML = html;
            parent.insertBefore(temp.firstElementChild, el);
          }
          parent.removeChild(el);
          return document.getElementById(firstP.id);
        },
        // Redo: paragraphs → blockquote
        (el) => {
          const parent = el.parentNode;
          const newBq = document.createElement("blockquote");
          const allParas = [el, ...extraIds.map(id => document.getElementById(id)).filter(Boolean)];
          const c = allParas.map(p => p.innerHTML).join("<br>");
          newBq.innerHTML = c + "<br>";
          newBq.id = el.id;
          if (el.hasAttribute("data-node-id")) newBq.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          for (const p of allParas.slice(1)) {
            p.remove();
          }
          parent.replaceChild(newBq, el);
          return newBq;
        },
        this.currentBookId,
        0
      );
    }

    // Insert blockquote where first paragraph was, remove all paragraphs
    firstP.parentNode.insertBefore(bq, firstP);
    for (const p of paragraphs) {
      p.remove();
    }

    // Save blockquote to IndexedDB
    if (this.saveToIndexedDBCallback) {
      await this.saveToIndexedDBCallback(bq.id, bq.outerHTML);
    }

    // Delete extra paragraphs from IndexedDB
    if (this.deleteFromIndexedDBCallback) {
      for (const id of extraIds) {
        await this.deleteFromIndexedDBCallback(id);
      }
    }

    this.selectionManager.currentSelection = window.getSelection();
    setCursorAtTextOffset(bq, 0);

    return { modifiedElementId: bq.id, newElement: bq };
  }

  /**
   * Handle removing a list — unwrap list items back to paragraphs
   * @param {HTMLElement} parentElement - the element containing the cursor
   */
  async handleRemoveList(parentElement) {
    let modifiedElementId = null;
    let newElement = null;

    // Capture cursor offset before any DOM changes
    const sel = this.selectionManager.currentSelection;
    const cursorLi = findClosestListItem(parentElement);
    let cursorOffset = 0;
    if (cursorLi && sel.focusNode) {
      try {
        cursorOffset = getTextOffsetInElement(cursorLi, sel.focusNode, sel.focusOffset);
      } catch (e) { /* ignore */ }
    }

    // Walk up to find the containing list element with an ID
    let listEl = parentElement;
    while (listEl && listEl.tagName !== "UL" && listEl.tagName !== "OL") {
      listEl = listEl.parentElement;
    }
    if (!listEl || !listEl.id) {
      console.warn("Cannot remove list — no list element with ID found");
      return { modifiedElementId, newElement };
    }

    const listItems = Array.from(listEl.querySelectorAll(":scope > li"));
    if (listItems.length === 0) {
      return { modifiedElementId, newElement };
    }

    // Determine which li index the cursor was in (for restoring position)
    let cursorLiIndex = cursorLi ? listItems.indexOf(cursorLi) : 0;
    if (cursorLiIndex < 0) cursorLiIndex = 0;

    const listParent = listEl.parentNode;
    const listTag = listEl.tagName.toLowerCase();
    const paragraphs = [];

    for (let i = 0; i < listItems.length; i++) {
      const li = listItems[i];
      const p = document.createElement("p");
      p.innerHTML = li.innerHTML || "\u00A0";

      if (i === 0) {
        // First paragraph inherits the list's identity
        p.id = listEl.id;
        if (listEl.hasAttribute("data-node-id")) {
          p.setAttribute("data-node-id", listEl.getAttribute("data-node-id"));
        }
      } else {
        // Subsequent paragraphs get new IDs
        const prevId = paragraphs[i - 1].id;
        const afterId = findNextElementId(listEl);
        setElementIds(p, prevId, afterId, this.currentBookId);
      }

      paragraphs.push(p);
    }

    // Record for undo/redo
    if (this.undoManager) {
      const oldListHTML = listEl.outerHTML;
      const listId = listEl.id;
      const extraParagraphIds = paragraphs.slice(1).map(p => p.id);

      this.undoManager.recordFormat(
        listId,
        // Undo: paragraphs → list (restore original)
        (el) => {
          // el is the first paragraph; remove extra paragraphs and restore list
          for (const extraId of extraParagraphIds) {
            const extra = document.getElementById(extraId);
            if (extra) extra.remove();
          }
          const temp = document.createElement("div");
          temp.innerHTML = oldListHTML;
          const restored = temp.firstElementChild;
          el.parentNode.replaceChild(restored, el);
          return restored;
        },
        // Redo: list → paragraphs
        (el) => {
          // el is the list; unwrap again
          const items = Array.from(el.querySelectorAll(":scope > li"));
          const ps = [];
          for (let i = 0; i < items.length; i++) {
            const newP = document.createElement("p");
            newP.innerHTML = items[i].innerHTML || "\u00A0";
            if (i === 0) {
              newP.id = el.id;
              if (el.hasAttribute("data-node-id")) newP.setAttribute("data-node-id", el.getAttribute("data-node-id"));
            } else {
              newP.id = extraParagraphIds[i - 1] || "";
            }
            ps.push(newP);
          }
          const parent = el.parentNode;
          for (const newP of ps) {
            parent.insertBefore(newP, el);
          }
          parent.removeChild(el);
          return ps[0];
        },
        this.currentBookId,
        0
      );
    }

    // Insert all paragraphs before the list, then remove the list
    for (const p of paragraphs) {
      listParent.insertBefore(p, listEl);
    }
    listParent.removeChild(listEl);

    // Restore cursor in the paragraph that corresponds to the li the cursor was in
    const targetParagraph = paragraphs[cursorLiIndex] || paragraphs[0];
    setCursorAtTextOffset(targetParagraph, cursorOffset);

    modifiedElementId = paragraphs[0].id;
    newElement = paragraphs[0];

    this.selectionManager.currentSelection = window.getSelection();

    // Save all paragraphs to IndexedDB
    if (this.saveToIndexedDBCallback) {
      for (const p of paragraphs) {
        if (p.id) {
          await this.saveToIndexedDBCallback(p.id, p.outerHTML);
        }
      }
    }

    // Delete the original list from IndexedDB (only if there were extra items)
    // The first paragraph inherited the list's ID, so that record gets updated above.
    // Extra paragraphs are new records. No separate delete needed since the ID was reused.

    return { modifiedElementId, newElement };
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
