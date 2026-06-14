// Heading commands extracted from blockFormatter (self = the BlockFormatter instance).

import {
  findClosestBlockParent,
  getBlockElementsInRange,
  getTextOffsetInElement,
  setCursorAtTextOffset,
  selectAcrossElements,
  findClosestListItem,
  isBlockElement,
} from "../toolbarDOMUtils";
import {
  setElementIds,
  findPreviousElementId,
  findNextElementId,
} from "../../utilities/IDfunctions.js";
import {
  batchUpdateIndexedDBRecords,
} from "../../indexedDB/index";

export async function handleHeadingFormat(self: any, isTextSelected: any, parentElement: any, headingLevel: any) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      // Multi-block heading formatting — uses replaceChild + undo stack
      const range = self.selectionManager.currentSelection.getRangeAt(0);
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
          if (self.undoManager) {
            const oldTag = block.tagName.toLowerCase();
            const newTag = newBlockElement.tagName.toLowerCase();
            self.undoManager.recordFormat(
              block.id,
              (el: any) => {
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
              (el: any) => {
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
              self.currentBookId,
              0
            );
          }
          block.parentNode!.replaceChild(newBlockElement, block);

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
        self.selectionManager.currentSelection = window.getSelection();

        if (recordsToUpdate.length > 0) {
          batchUpdateIndexedDBRecords(recordsToUpdate);
        }

        return { modifiedElementId, newElement };
      }
    }

    // Cursor-only heading formatting
    const focusNode = self.selectionManager.currentSelection.focusNode;
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
        self.selectionManager.currentSelection.focusNode,
        self.selectionManager.currentSelection.focusOffset
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
      if (self.undoManager) {
        const oldTag = currentHeadingLevel;
        const newTag = targetTag;
        self.undoManager.recordFormat(
          headingElement.id,
          (el: any) => {
            const r = document.createElement(oldTag);
            r.innerHTML = el.innerHTML;
            r.id = el.id;
            if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
            el.parentNode.replaceChild(r, el);
            return r;
          },
          (el: any) => {
            const r = document.createElement(newTag);
            r.innerHTML = el.innerHTML;
            r.id = el.id;
            if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
            el.parentNode.replaceChild(r, el);
            return r;
          },
          self.currentBookId,
          currentOffset
        );
      }

      headingElement.parentNode.replaceChild(newEl, headingElement);
      setCursorAtTextOffset(newEl, currentOffset);
      modifiedElementId = newEl.id;
      newElement = newEl;

      self.selectionManager.currentSelection = window.getSelection();
    } else if (blockParent) {
      // Converting from paragraph (or other block) to heading
      const isCodeBlock = blockParent.tagName === 'PRE';
      const currentOffset = getTextOffsetInElement(
        blockParent,
        self.selectionManager.currentSelection.focusNode,
        self.selectionManager.currentSelection.focusOffset
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
          setElementIds(headingElement, beforeId, afterId, self.currentBookId);
        }

        if (blockParent.hasAttribute('data-node-id')) {
          headingElement.setAttribute('data-node-id', blockParent.getAttribute('data-node-id'));
        }

        if (self.undoManager) {
          const targetLevel = headingLevel;
          self.undoManager.recordFormat(
            blockParent.id,
            (el: any) => {
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
            (el: any) => {
              // Redo: pre → heading
              const h = document.createElement(targetLevel);
              const codeEl = el.querySelector('code');
              h.textContent = codeEl ? codeEl.textContent : el.textContent;
              h.id = el.id;
              if (el.hasAttribute('data-node-id')) h.setAttribute('data-node-id', el.getAttribute('data-node-id'));
              el.parentNode.replaceChild(h, el);
              return h;
            },
            self.currentBookId,
            currentOffset
          );
        }
        blockParent.parentNode!.replaceChild(headingElement, blockParent);

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
        if (self.undoManager) {
          const oldTag = blockParent.tagName.toLowerCase();
          const newTag = headingLevel;
          self.undoManager.recordFormat(
            blockParent.id,
            (el: any) => {
              const r = document.createElement(oldTag);
              r.innerHTML = el.innerHTML;
              r.id = el.id;
              if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
              el.parentNode.replaceChild(r, el);
              return r;
            },
            (el: any) => {
              const r = document.createElement(newTag);
              r.innerHTML = el.innerHTML;
              r.id = el.id;
              if (el.hasAttribute('data-node-id')) r.setAttribute('data-node-id', el.getAttribute('data-node-id'));
              el.parentNode.replaceChild(r, el);
              return r;
            },
            self.currentBookId,
            currentOffset
          );
        }

        blockParent.parentNode!.replaceChild(newEl, blockParent);
        setCursorAtTextOffset(newEl, currentOffset);
        modifiedElementId = newEl.id;
        newElement = newEl;
      }

      self.selectionManager.currentSelection = window.getSelection();
    }

    return { modifiedElementId, newElement };
  }

export async function unwrapSelectedTextFromHeading(self: any) {
    if (!self.selectionManager.currentSelection || self.selectionManager.currentSelection.isCollapsed) {
      console.warn("unwrapSelectedTextFromHeading called with no selection.");
      return null;
    }

    const range = self.selectionManager.currentSelection.getRangeAt(0);
    let headingElement = null;
    let currentElement = self.selectionManager.getSelectionParentElement();

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

    setElementIds(pElement, beforeOriginalId, afterOriginalId, self.currentBookId);

    try {
      // Record content-preserving operation before replaceChild
      if (self.undoManager) {
        const origTag = headingElement.tagName.toLowerCase();
        self.undoManager.recordFormat(
          headingElement.id,
          (el: any) => {
            // Undo: p → heading
            const h = document.createElement(origTag);
            h.innerHTML = el.innerHTML;
            h.id = el.id;
            if (el.hasAttribute('data-node-id')) h.setAttribute('data-node-id', el.getAttribute('data-node-id'));
            el.parentNode.replaceChild(h, el);
            return h;
          },
          (el: any) => {
            // Redo: heading → p
            const p = document.createElement('p');
            p.innerHTML = el.innerHTML;
            p.id = el.id;
            if (el.hasAttribute('data-node-id')) p.setAttribute('data-node-id', el.getAttribute('data-node-id'));
            el.parentNode.replaceChild(p, el);
            return p;
          },
          self.currentBookId,
          0
        );
      }
      headingElement.parentNode.replaceChild(pElement, headingElement);
    } catch (domError) {
      console.error("unwrapSelectedTextFromHeading: DOM replacement failed.", domError);
      return null;
    }

    if (self.selectionManager.currentSelection) {
      const newRange = document.createRange();
      newRange.selectNodeContents(pElement);
      self.selectionManager.currentSelection.removeAllRanges();
      self.selectionManager.currentSelection.addRange(newRange);
    }

    console.log(`unwrapSelectedTextFromHeading: New paragraph ID "${pElement.id}"`);

    if (self.currentBookId) {
      if (self.saveToIndexedDBCallback) {
        await self.saveToIndexedDBCallback(pElement.id, pElement.outerHTML);
      }
      if (self.deleteFromIndexedDBCallback) {
        await self.deleteFromIndexedDBCallback(headingElement.id);
      }
    }

    return {
      id: pElement.id,
      element: pElement,
    };
  }
