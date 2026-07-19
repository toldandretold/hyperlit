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
} from "../../utilities/idHelpers";
import {
  batchUpdateIndexedDBRecords,
} from "../../indexedDB/index";
import { asLineId } from "../../utilities/idHelpers";
import type { BlockCommandContext } from "./types";

// Both helpers MOVE the live child nodes into the new element \u2014 never rebuild
// via innerHTML re-parse. Re-parsing cloned every child (hypercite <u>/<a>,
// highlight <mark>) and destroyed live node identity: listeners died, the
// MutationObserver saw removal churn for every embedded hypercite, and the
// browser's native undo stack (iOS shake-undo) was left pointing at destroyed
// nodes \u2014 the source of the format-toggle duplication bug.
export function _contentPreservingWrap(self: BlockCommandContext, element: Element, type: 'blockquote' | 'code'): HTMLElement {
    let newEl: HTMLElement;
    if (type === "blockquote") {
      newEl = document.createElement("blockquote");
      while (element.firstChild) newEl.appendChild(element.firstChild);
      // Blockquote convention: content ends with a <br> (empty stays empty)
      if (newEl.lastChild && newEl.lastChild.nodeName !== "BR") {
        newEl.appendChild(document.createElement("br"));
      }
    } else {
      newEl = document.createElement("pre");
      const code = document.createElement("code");
      while (element.firstChild) code.appendChild(element.firstChild);
      newEl.appendChild(code);
    }

    newEl.id = element.id;
    if (element.hasAttribute("data-node-id")) {
      newEl.setAttribute("data-node-id", element.getAttribute("data-node-id")!);
    }

    element.parentNode!.replaceChild(newEl, element);
    return newEl;
  }

export function _contentPreservingUnwrap(self: BlockCommandContext, element: Element, type: 'blockquote' | 'code'): HTMLElement {
    const p = document.createElement("p");

    const source: Element = type === "code" ? (element.querySelector("code") ?? element) : element;
    if (type === "blockquote" && source.lastChild && source.lastChild.nodeName === "BR") {
      source.lastChild.remove(); // strip the wrap-convention trailing <br>
    }
    while (source.firstChild) p.appendChild(source.firstChild);
    if (!p.hasChildNodes()) p.textContent = "\u00A0";

    p.id = element.id;
    if (element.hasAttribute("data-node-id")) {
      p.setAttribute("data-node-id", element.getAttribute("data-node-id")!);
    }

    element.parentNode!.replaceChild(p, element);
    return p;
  }

export async function handleBlockquoteCodeFormat(self: BlockCommandContext, type: 'blockquote' | 'code', isTextSelected: boolean, parentElement: Element) {
    let modifiedElementId = null;
    let newElement = null;

    if (isTextSelected) {
      // Multi-paragraph wrapping
      const range = self.selectionManager.currentSelection!.getRangeAt(0);
      const affectedBlocks = getBlockElementsInRange(range);

      // Only allow paragraph elements for blockquote/code conversion
      const paragraphBlocks = affectedBlocks.filter((block): block is HTMLElement => block.tagName === 'P');

      if (paragraphBlocks.length > 1 && type === "blockquote") {
        // Multiple paragraphs → merge into a single blockquote (items joined by <br>)
        return await self._mergeBlocksIntoBlockquote(paragraphBlocks);
      } else if (paragraphBlocks.length > 0) {
        // Single paragraph or code: convert each paragraph to its own block (1:1)
        // This preserves node_ids so highlights stay connected
        const createdBlocks: HTMLElement[] = [];

        for (const block of paragraphBlocks) {
          const newBlockElement = self._contentPreservingWrap(block, type);

          if (self.undoManager) {
            self.undoManager.recordFormat(
              newBlockElement.id,
              (el: HTMLElement) => self._contentPreservingUnwrap(el, type),
              (el: HTMLElement) => self._contentPreservingWrap(el, type),
              self.currentBookId,
              0
            );
          }
          createdBlocks.push(newBlockElement);

          // Save (no delete needed since node_id is preserved)
          if (self.currentBookId && self.saveToIndexedDBCallback) {
            await self.saveToIndexedDBCallback(asLineId(newBlockElement.id), newBlockElement.outerHTML);
          }
        }

        // Select the first new block
        if (createdBlocks.length > 0) {
          self.selectionManager.currentSelection!.selectAllChildren(createdBlocks[0]!);
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
            await self.saveToIndexedDBCallback(asLineId(modifiedElementId), newElement.outerHTML);
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

export async function unwrapBlock(self: BlockCommandContext, blockToUnwrap: Element, type: 'blockquote' | 'code') {
    // Capture cursor offset before DOM replacement
    const currentOffset = getTextOffsetInElement(
      blockToUnwrap,
      self.selectionManager.currentSelection!.focusNode,
      self.selectionManager.currentSelection!.focusOffset
    );

    const newElement = self._contentPreservingUnwrap(blockToUnwrap, type);
    const modifiedElementId = newElement.id;

    if (self.undoManager) {
      self.undoManager.recordFormat(
        newElement.id,
        (el: HTMLElement) => self._contentPreservingWrap(el, type),
        (el: HTMLElement) => self._contentPreservingUnwrap(el, type),
        self.currentBookId,
        currentOffset
      );
    }

    setCursorAtTextOffset(newElement, currentOffset);

    await batchUpdateIndexedDBRecords([{ id: asLineId(newElement.id), html: newElement.outerHTML }]);

    return { modifiedElementId, newElement };
  }

export async function wrapBlock(self: BlockCommandContext, blockParentToToggle: Element, type: 'blockquote' | 'code') {
    const currentOffset = getTextOffsetInElement(
      blockParentToToggle,
      self.selectionManager.currentSelection!.focusNode,
      self.selectionManager.currentSelection!.focusOffset
    );

    const newElement = self._contentPreservingWrap(blockParentToToggle, type);
    const modifiedElementId = newElement.id;

    if (self.undoManager) {
      self.undoManager.recordFormat(
        newElement.id,
        (el: HTMLElement) => self._contentPreservingUnwrap(el, type),
        (el: HTMLElement) => self._contentPreservingWrap(el, type),
        self.currentBookId,
        currentOffset
      );
    }

    setCursorAtTextOffset(newElement, currentOffset);

    // Since we preserve node_id, just save the updated content (no delete needed)
    if (self.saveToIndexedDBCallback && newElement.id) {
      await self.saveToIndexedDBCallback(asLineId(newElement.id), newElement.outerHTML);
    }

    return { modifiedElementId, newElement };
  }

export async function _mergeBlocksIntoBlockquote(self: BlockCommandContext, paragraphs: HTMLElement[]) {
    const bq = document.createElement("blockquote");

    // Inherit identity from first paragraph
    const firstP = paragraphs[0]!;
    bq.id = firstP.id;
    if (firstP.hasAttribute("data-node-id")) {
      bq.setAttribute("data-node-id", firstP.getAttribute("data-node-id")!);
    }

    // Snapshot for undo — BEFORE moving children empties the paragraphs
    const originalParagraphsHTML = paragraphs.map((p: HTMLElement) => p.outerHTML);
    const extraIds = paragraphs.slice(1).map((p: HTMLElement) => p.id);

    // Move live children (same reasoning as _contentPreservingWrap), one <br>
    // between paragraphs plus the trailing convention <br>.
    // NOTE: the undo/redo closures below still rebuild from HTML snapshots by
    // design (explicit toolbar undo) — converting them is a separate refactor.
    paragraphs.forEach((para: HTMLElement, i: number) => {
      if (i > 0) bq.appendChild(document.createElement("br"));
      while (para.firstChild) bq.appendChild(para.firstChild);
    });
    bq.appendChild(document.createElement("br"));

    // Record undo
    if (self.undoManager) {
      self.undoManager.recordFormat(
        firstP.id,
        // Undo: blockquote → paragraphs (restore originals)
        (el: HTMLElement) => {
          const parent = el.parentNode!;
          // Insert all paragraphs before the blockquote, then remove it
          for (const html of originalParagraphsHTML) {
            const temp = document.createElement("div");
            temp.innerHTML = html;
            parent.insertBefore(temp.firstElementChild!, el);
          }
          parent.removeChild(el);
          return document.getElementById(firstP.id);
        },
        // Redo: paragraphs → blockquote
        (el: HTMLElement) => {
          const parent = el.parentNode!;
          const newBq = document.createElement("blockquote");
          const allParas = [el, ...extraIds.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => x !== null)];
          const c = allParas.map((p: HTMLElement) => p.innerHTML).join("<br>");
          newBq.innerHTML = c + "<br>";
          newBq.id = el.id;
          if (el.hasAttribute("data-node-id")) newBq.setAttribute("data-node-id", el.getAttribute("data-node-id")!);
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
    firstP.parentNode!.insertBefore(bq, firstP);
    for (const p of paragraphs) {
      p.remove();
    }

    // Save blockquote to IndexedDB
    if (self.saveToIndexedDBCallback) {
      await self.saveToIndexedDBCallback(asLineId(bq.id), bq.outerHTML);
    }

    // Delete extra paragraphs from IndexedDB
    if (self.deleteFromIndexedDBCallback) {
      for (const id of extraIds) {
        await self.deleteFromIndexedDBCallback(asLineId(id));
      }
    }

    self.selectionManager.currentSelection = window.getSelection();
    setCursorAtTextOffset(bq, 0);

    return { modifiedElementId: bq.id, newElement: bq };
  }
