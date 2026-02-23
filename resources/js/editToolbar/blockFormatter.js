/**
 * Block Formatter for EditToolbar
 *
 * Handles block-level formatting operations:
 * - Heading formatting (H1-H6) - multi-block and cursor-only
 * - Blockquote formatting - wrapping/unwrapping
 * - Code block formatting - wrapping/unwrapping with HTML preservation
 * - Paragraph conversion from headings
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
  batchDeleteIndexedDBRecords,
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
   * Handle heading formatting (both multi-block and cursor-only)
   */
  async handleHeadingFormat(isTextSelected, parentElement, headingLevel) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      // Multi-block heading formatting
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
      const beforeId = findPreviousElementId(headingElement);
      const afterId = findNextElementId(headingElement);
      const currentOffset = getTextOffsetInElement(
        headingElement,
        this.selectionManager.currentSelection.focusNode,
        this.selectionManager.currentSelection.focusOffset
      );

      if (currentHeadingLevel === headingLevel) {
        // Same level - convert to paragraph (toggle off)
        const pElement = document.createElement("p");
        pElement.innerHTML = headingElement.innerHTML;
        const newPId = headingElement.id;
        if (newPId) {
          pElement.id = newPId;
        } else {
          setElementIds(pElement, beforeId, afterId, this.currentBookId);
        }

        if (headingElement.hasAttribute('data-node-id')) {
          pElement.setAttribute('data-node-id', headingElement.getAttribute('data-node-id'));
        }

        headingElement.parentNode.replaceChild(pElement, headingElement);
        setCursorAtTextOffset(pElement, currentOffset);
        modifiedElementId = newPId;
        newElement = pElement;
      } else {
        // Different level - convert to new heading level
        const newHeadingElement = document.createElement(headingLevel);
        newHeadingElement.innerHTML = headingElement.innerHTML;
        const newHeadingId = headingElement.id;
        if (newHeadingId) {
          newHeadingElement.id = newHeadingId;
        } else {
          setElementIds(newHeadingElement, beforeId, afterId, this.currentBookId);
        }

        if (headingElement.hasAttribute('data-node-id')) {
          newHeadingElement.setAttribute('data-node-id', headingElement.getAttribute('data-node-id'));
        }

        headingElement.parentNode.replaceChild(newHeadingElement, headingElement);
        setCursorAtTextOffset(newHeadingElement, currentOffset);
        modifiedElementId = newHeadingId;
        newElement = newHeadingElement;
      }

      this.selectionManager.currentSelection = window.getSelection();
    } else if (blockParent) {
      // Converting from paragraph (or other block) to heading
      const isCodeBlock = blockParent.tagName === 'PRE';
      const beforeId = findPreviousElementId(blockParent);
      const afterId = findNextElementId(blockParent);
      const currentOffset = getTextOffsetInElement(
        blockParent,
        this.selectionManager.currentSelection.focusNode,
        this.selectionManager.currentSelection.focusOffset
      );

      const headingElement = document.createElement(headingLevel);

      // Handle code blocks specially - extract text content from <code> element
      if (isCodeBlock) {
        const codeElement = blockParent.querySelector('code');
        headingElement.textContent = codeElement ? codeElement.textContent : blockParent.textContent;
      } else {
        headingElement.innerHTML = blockParent.innerHTML;
      }

      const newHeadingId = blockParent.id;
      if (newHeadingId) {
        headingElement.id = newHeadingId;
      } else {
        setElementIds(headingElement, beforeId, afterId, this.currentBookId);
      }

      if (blockParent.hasAttribute('data-node-id')) {
        headingElement.setAttribute('data-node-id', blockParent.getAttribute('data-node-id'));
      }

      blockParent.parentNode.replaceChild(headingElement, blockParent);
      setCursorAtTextOffset(headingElement, currentOffset);
      modifiedElementId = newHeadingId;
      newElement = headingElement;

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
          const beforeId = findPreviousElementId(block);
          const afterId = findNextElementId(block);

          let newBlockElement;
          if (type === "blockquote") {
            newBlockElement = document.createElement("blockquote");
            let content = block.innerHTML;
            if (content && !content.endsWith("<br>")) content += "<br>";
            newBlockElement.innerHTML = content;
          } else {
            // Code block - use innerHTML to preserve marks/highlights
            newBlockElement = document.createElement("pre");
            const codeElement = document.createElement("code");
            codeElement.innerHTML = block.innerHTML;
            newBlockElement.appendChild(codeElement);
          }

          // Preserve the paragraph's node_id
          const oldNodeId = block.getAttribute('data-node-id');
          if (oldNodeId) {
            newBlockElement.setAttribute('data-node-id', oldNodeId);
          }

          setElementIds(newBlockElement, beforeId, afterId, this.currentBookId);

          // Replace in place
          block.parentNode.replaceChild(newBlockElement, block);
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
    const beforeOriginalId = findPreviousElementId(blockToUnwrap);
    const afterOriginalId = findNextElementId(blockToUnwrap);

    const fragment = document.createDocumentFragment();
    let lastId = beforeOriginalId;
    let firstNewP = null;
    const createdP_ids_with_html = [];

    // Track if this is a 1:1 conversion (blockquote) so we can skip the delete
    let isSingleNodeConversion = false;

    if (type === "blockquote") {
      // For blockquotes, preserve HTML formatting (1:1 conversion)
      isSingleNodeConversion = true;
      const p = document.createElement("p");
      let content = blockToUnwrap.innerHTML;
      if (content.endsWith("<br>")) {
        content = content.slice(0, -4);
      }
      p.innerHTML = content || "\u00A0";
      // Preserve the blockquote's node_id so hyperlights/hypercites stay connected
      const oldNodeId = blockToUnwrap.getAttribute('data-node-id');
      if (oldNodeId) {
        p.setAttribute('data-node-id', oldNodeId);
      }
      setElementIds(p, lastId, afterOriginalId, this.currentBookId);
      firstNewP = p;
      fragment.appendChild(p);
      createdP_ids_with_html.push({ id: p.id, html: p.outerHTML });
    } else {
      // For code blocks - 1:1 conversion, preserve node_id and HTML content
      isSingleNodeConversion = true;
      const codeElement = blockToUnwrap.querySelector('code');
      const htmlContent = codeElement ? codeElement.innerHTML : blockToUnwrap.textContent;

      const p = document.createElement("p");
      p.innerHTML = htmlContent || "\u00A0";

      // Preserve the code block's node_id so hyperlights/hypercites stay connected
      const oldNodeId = blockToUnwrap.getAttribute('data-node-id');
      if (oldNodeId) {
        p.setAttribute('data-node-id', oldNodeId);
      }
      setElementIds(p, lastId, afterOriginalId, this.currentBookId);
      firstNewP = p;
      fragment.appendChild(p);
      createdP_ids_with_html.push({ id: p.id, html: p.outerHTML });
    }

    let modifiedElementId = null;
    let newElement = null;

    if (fragment.childNodes.length > 0) {
      blockToUnwrap.parentNode.replaceChild(fragment, blockToUnwrap);
      newElement = firstNewP;
      modifiedElementId = newElement.id;
      setCursorAtTextOffset(newElement, 0);

      await batchUpdateIndexedDBRecords(createdP_ids_with_html);
      // Only delete the old block for 1:N conversions (code blocks)
      // For 1:1 conversions (blockquote), we preserve node_id so no delete needed
      if (!isSingleNodeConversion && blockToUnwrap.id && this.deleteFromIndexedDBCallback) {
        await this.deleteFromIndexedDBCallback(blockToUnwrap.id);
      }
    } else {
      // Handle empty case
      const p = document.createElement("p");
      p.innerHTML = "&nbsp;";
      setElementIds(p, beforeOriginalId, afterOriginalId, this.currentBookId);
      blockToUnwrap.parentNode.replaceChild(p, blockToUnwrap);
      newElement = p;
      modifiedElementId = p.id;
      setCursorAtTextOffset(newElement, 0);

      if (this.saveToIndexedDBCallback) {
        await this.saveToIndexedDBCallback(p.id, p.outerHTML);
      }
      if (blockToUnwrap.id && this.deleteFromIndexedDBCallback) {
        await this.deleteFromIndexedDBCallback(blockToUnwrap.id);
      }
    }

    return { modifiedElementId, newElement };
  }

  /**
   * Wrap a paragraph in a blockquote or code block
   */
  async wrapBlock(blockParentToToggle, type) {
    const beforeId = findPreviousElementId(blockParentToToggle);
    const afterId = findNextElementId(blockParentToToggle);
    const currentOffset = getTextOffsetInElement(
      blockParentToToggle,
      this.selectionManager.currentSelection.focusNode,
      this.selectionManager.currentSelection.focusOffset
    );

    let newBlockElement;
    if (type === "blockquote") {
      newBlockElement = document.createElement("blockquote");
      let content = blockParentToToggle.innerHTML;
      if (content && !content.endsWith("<br>")) content += "<br>";
      newBlockElement.innerHTML = content;
    } else {
      newBlockElement = document.createElement("pre");
      const code = document.createElement("code");
      // Use innerHTML to preserve marks/highlights instead of escaping them
      code.innerHTML = blockParentToToggle.innerHTML;
      newBlockElement.appendChild(code);
    }

    // Preserve the old node_id so hyperlights/hypercites stay connected
    const oldNodeId = blockParentToToggle.getAttribute('data-node-id');
    if (oldNodeId) {
      newBlockElement.setAttribute('data-node-id', oldNodeId);
    }
    setElementIds(newBlockElement, beforeId, afterId, this.currentBookId);
    blockParentToToggle.parentNode.replaceChild(newBlockElement, blockParentToToggle);

    const newElement = newBlockElement;
    const modifiedElementId = newElement.id;
    setCursorAtTextOffset(newElement, currentOffset);

    // Since we preserve node_id, just save the updated content (no delete needed)
    if (this.saveToIndexedDBCallback && newBlockElement.id) {
      await this.saveToIndexedDBCallback(newBlockElement.id, newBlockElement.outerHTML);
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
