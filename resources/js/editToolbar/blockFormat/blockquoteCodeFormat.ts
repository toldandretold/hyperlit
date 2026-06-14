// Blockquote/code commands + content-preserving wrap/unwrap helpers (self = BlockFormatter).

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

export function _contentPreservingWrap(self: any, element: any, type: any) {
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

export function _contentPreservingUnwrap(self: any, element: any, type: any) {
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

export async function handleBlockquoteCodeFormat(self: any, type: any, isTextSelected: any, parentElement: any) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      // Multi-paragraph wrapping
      const range = self.selectionManager.currentSelection.getRangeAt(0);
      const affectedBlocks = getBlockElementsInRange(range);

      // Only allow paragraph elements for blockquote/code conversion
      const paragraphBlocks = affectedBlocks.filter((block: any) => block.tagName === 'P');

      if (paragraphBlocks.length > 1 && type === "blockquote") {
        // Multiple paragraphs → merge into a single blockquote (items joined by <br>)
        return await self._mergeBlocksIntoBlockquote(paragraphBlocks);
      } else if (paragraphBlocks.length > 0) {
        // Single paragraph or code: convert each paragraph to its own block (1:1)
        // This preserves node_ids so highlights stay connected
        const createdBlocks = [];

        for (const block of paragraphBlocks) {
          const newBlockElement = self._contentPreservingWrap(block, type);

          if (self.undoManager) {
            self.undoManager.recordFormat(
              newBlockElement.id,
              (el: any) => self._contentPreservingUnwrap(el, type),
              (el: any) => self._contentPreservingWrap(el, type),
              self.currentBookId,
              0
            );
          }
          createdBlocks.push(newBlockElement);

          // Save (no delete needed since node_id is preserved)
          if (self.currentBookId && self.saveToIndexedDBCallback) {
            await self.saveToIndexedDBCallback(newBlockElement.id, newBlockElement.outerHTML);
          }
        }

        // Select the first new block
        if (createdBlocks.length > 0) {
          self.selectionManager.currentSelection.selectAllChildren(createdBlocks[0]);
          modifiedElementId = createdBlocks[0]!.id;
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
          if (newElem && self.saveToIndexedDBCallback) {
            setElementIds(newElem, beforeId, afterId, self.currentBookId);
            modifiedElementId = newElem.id;
            newElement = newElem;
            await self.saveToIndexedDBCallback(modifiedElementId, newElement.outerHTML);
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
        ({ modifiedElementId, newElement } = await self.unwrapBlock(blockParentToToggle, type));
      } else if (blockParentToToggle) {
        // WRAPPING
        ({ modifiedElementId, newElement } = await self.wrapBlock(blockParentToToggle, type));
      }
    }

    return { modifiedElementId, newElement };
  }

export async function unwrapBlock(self: any, blockToUnwrap: any, type: any) {
    // Capture cursor offset before DOM replacement
    const currentOffset = getTextOffsetInElement(
      blockToUnwrap,
      self.selectionManager.currentSelection.focusNode,
      self.selectionManager.currentSelection.focusOffset
    );

    const newElement = self._contentPreservingUnwrap(blockToUnwrap, type);
    const modifiedElementId = newElement.id;

    if (self.undoManager) {
      self.undoManager.recordFormat(
        newElement.id,
        (el: any) => self._contentPreservingWrap(el, type),
        (el: any) => self._contentPreservingUnwrap(el, type),
        self.currentBookId,
        currentOffset
      );
    }

    setCursorAtTextOffset(newElement, currentOffset);

    await batchUpdateIndexedDBRecords([{ id: newElement.id, html: newElement.outerHTML }]);

    return { modifiedElementId, newElement };
  }

export async function wrapBlock(self: any, blockParentToToggle: any, type: any) {
    const currentOffset = getTextOffsetInElement(
      blockParentToToggle,
      self.selectionManager.currentSelection.focusNode,
      self.selectionManager.currentSelection.focusOffset
    );

    const newElement = self._contentPreservingWrap(blockParentToToggle, type);
    const modifiedElementId = newElement.id;

    if (self.undoManager) {
      self.undoManager.recordFormat(
        newElement.id,
        (el: any) => self._contentPreservingUnwrap(el, type),
        (el: any) => self._contentPreservingWrap(el, type),
        self.currentBookId,
        currentOffset
      );
    }

    setCursorAtTextOffset(newElement, currentOffset);

    // Since we preserve node_id, just save the updated content (no delete needed)
    if (self.saveToIndexedDBCallback && newElement.id) {
      await self.saveToIndexedDBCallback(newElement.id, newElement.outerHTML);
    }

    return { modifiedElementId, newElement };
  }

export async function _mergeBlocksIntoBlockquote(self: any, paragraphs: any) {
    const bq = document.createElement("blockquote");
    const content = paragraphs.map((p: any) => p.innerHTML).join("<br>");
    bq.innerHTML = content + "<br>";

    // Inherit identity from first paragraph
    const firstP = paragraphs[0];
    bq.id = firstP.id;
    if (firstP.hasAttribute("data-node-id")) {
      bq.setAttribute("data-node-id", firstP.getAttribute("data-node-id"));
    }

    // Snapshot for undo
    const originalParagraphsHTML = paragraphs.map((p: any) => p.outerHTML);
    const extraIds = paragraphs.slice(1).map((p: any) => p.id);

    // Record undo
    if (self.undoManager) {
      self.undoManager.recordFormat(
        firstP.id,
        // Undo: blockquote → paragraphs (restore originals)
        (el: any) => {
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
        (el: any) => {
          const parent = el.parentNode;
          const newBq = document.createElement("blockquote");
          const allParas = [el, ...extraIds.map((id: any) => document.getElementById(id)).filter(Boolean)];
          const c = allParas.map((p: any) => p.innerHTML).join("<br>");
          newBq.innerHTML = c + "<br>";
          newBq.id = el.id;
          if (el.hasAttribute("data-node-id")) newBq.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          for (const p of allParas.slice(1)) {
            p.remove();
          }
          parent.replaceChild(newBq, el);
          return newBq;
        },
        self.currentBookId,
        0
      );
    }

    // Insert blockquote where first paragraph was, remove all paragraphs
    firstP.parentNode.insertBefore(bq, firstP);
    for (const p of paragraphs) {
      p.remove();
    }

    // Save blockquote to IndexedDB
    if (self.saveToIndexedDBCallback) {
      await self.saveToIndexedDBCallback(bq.id, bq.outerHTML);
    }

    // Delete extra paragraphs from IndexedDB
    if (self.deleteFromIndexedDBCallback) {
      for (const id of extraIds) {
        await self.deleteFromIndexedDBCallback(id);
      }
    }

    self.selectionManager.currentSelection = window.getSelection();
    setCursorAtTextOffset(bq, 0);

    return { modifiedElementId: bq.id, newElement: bq };
  }
