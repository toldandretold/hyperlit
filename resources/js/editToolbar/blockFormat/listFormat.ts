// List commands extracted from blockFormatter (self = the BlockFormatter instance).

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
} from "../../utilities/IDfunctions";
import {
  batchUpdateIndexedDBRecords,
} from "../../indexedDB/index";

export async function handleListFormat(self: any, listType: any, parentElement: any, isTextSelected = false) {
    let modifiedElementId = null;
    let newElement = null;

    // Capture cursor offset before any DOM changes
    const sel = self.selectionManager.currentSelection;
    const focusNode = sel.focusNode;
    const focusOffset = sel.focusOffset;

    // Multi-paragraph selection → merge into a single list
    if (isTextSelected) {
      const range = sel.getRangeAt(0);
      const affectedBlocks = getBlockElementsInRange(range);
      const paragraphBlocks = affectedBlocks.filter((block: any) => block.tagName === 'P');

      if (paragraphBlocks.length > 1) {
        return await self._mergeBlocksIntoList(paragraphBlocks, listType);
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
        if (self.undoManager) {
          const oldTag = currentTag;
          const newTag = listType;
          self.undoManager.recordFormat(
            listEl.id,
            (el: any) => {
              const r = document.createElement(oldTag);
              r.id = el.id;
              if (el.hasAttribute("data-node-id")) r.setAttribute("data-node-id", el.getAttribute("data-node-id"));
              while (el.firstChild) r.appendChild(el.firstChild);
              el.parentNode.replaceChild(r, el);
              return r;
            },
            (el: any) => {
              const r = document.createElement(newTag);
              r.id = el.id;
              if (el.hasAttribute("data-node-id")) r.setAttribute("data-node-id", el.getAttribute("data-node-id"));
              while (el.firstChild) r.appendChild(el.firstChild);
              el.parentNode.replaceChild(r, el);
              return r;
            },
            self.currentBookId,
            currentOffset
          );
        }

        listEl.parentNode!.replaceChild(newListEl, listEl);

        // Restore cursor inside the same li (it was moved, not recreated)
        setCursorAtTextOffset(listItem, currentOffset);

        modifiedElementId = newListEl.id;
        newElement = newListEl;
        self.selectionManager.currentSelection = window.getSelection();
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
      if (self.undoManager) {
        self.undoManager.recordFormat(
          blockParent.id,
          // Undo: list → blockquote (restore original)
          (el: any) => {
            const temp = document.createElement("div");
            temp.innerHTML = originalBlockquoteHTML;
            const restored = temp.firstElementChild;
            el.parentNode.replaceChild(restored, el);
            return restored;
          },
          // Redo: blockquote → list (split on <br>)
          (el: any) => {
            let c = el.innerHTML;
            if (c.endsWith("<br>")) c = c.slice(0, -4);
            const ps = c.split(/<br\s*\/?>/i).filter((p: any) => p.trim() !== "");
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
          self.currentBookId,
          currentOffset
        );
      }

      blockParent.parentNode!.replaceChild(listEl, blockParent);
      // Place cursor in the first <li>
      const firstLi = listEl.querySelector("li");
      if (firstLi) setCursorAtTextOffset(firstLi, Math.min(currentOffset, firstLi.textContent.length));

      modifiedElementId = listEl.id;
      newElement = listEl;
      self.selectionManager.currentSelection = window.getSelection();
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
    if (self.undoManager) {
      self.undoManager.recordFormat(
        blockParent.id,
        // Undo: list → paragraph
        (el: any) => {
          const p = document.createElement("p");
          const firstLi = el.querySelector("li");
          p.innerHTML = firstLi ? firstLi.innerHTML : el.innerHTML;
          p.id = el.id;
          if (el.hasAttribute("data-node-id")) p.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          el.parentNode.replaceChild(p, el);
          return p;
        },
        // Redo: paragraph → list
        (el: any) => {
          const list = document.createElement(listType);
          const newLi = document.createElement("li");
          newLi.innerHTML = el.innerHTML;
          list.appendChild(newLi);
          list.id = el.id;
          if (el.hasAttribute("data-node-id")) list.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          el.parentNode.replaceChild(list, el);
          return list;
        },
        self.currentBookId,
        currentOffset
      );
    }

    blockParent.parentNode!.replaceChild(listEl, blockParent);

    // Place cursor inside the <li>
    setCursorAtTextOffset(li, currentOffset);

    modifiedElementId = listEl.id;
    newElement = listEl;

    self.selectionManager.currentSelection = window.getSelection();

    return { modifiedElementId, newElement };
  }

export async function handleListToBlock(self: any, listEl: any, listItem: any, blockType: any) {
    let modifiedElementId = null;
    let newElement = null;

    // Capture cursor offset before DOM changes
    const sel = self.selectionManager.currentSelection;
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
      const content = allItems.map((li: any) => li.innerHTML).join("<br>");
      newBlock.innerHTML = content + "<br>";
    } else {
      newBlock = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = allItems.map((li: any) => li.textContent.trim()).join("\n");
      newBlock.appendChild(code);
    }

    // Transfer identity
    newBlock.id = listEl.id;
    if (listEl.hasAttribute("data-node-id")) {
      newBlock.setAttribute("data-node-id", listEl.getAttribute("data-node-id"));
    }

    // Record undo: block ↔ list (single step)
    if (self.undoManager) {
      self.undoManager.recordFormat(
        listEl.id,
        // Undo: blockquote/code → list (restore original)
        (el: any) => {
          const temp = document.createElement("div");
          temp.innerHTML = originalListHTML;
          const restored = temp.firstElementChild;
          el.parentNode.replaceChild(restored, el);
          return restored;
        },
        // Redo: list → blockquote/code
        (el: any) => {
          let block;
          const items = Array.from(el.querySelectorAll(":scope > li"));
          if (blockType === "blockquote") {
            block = document.createElement("blockquote");
            const c = items.map((li: any) => li.innerHTML).join("<br>");
            block.innerHTML = c + "<br>";
          } else {
            block = document.createElement("pre");
            const code = document.createElement("code");
            code.textContent = items.map((li: any) => li.textContent.trim()).join("\n");
            block.appendChild(code);
          }
          block.id = el.id;
          if (el.hasAttribute("data-node-id")) block.setAttribute("data-node-id", el.getAttribute("data-node-id"));
          el.parentNode.replaceChild(block, el);
          return block;
        },
        self.currentBookId,
        currentOffset
      );
    }

    listEl.parentNode!.replaceChild(newBlock, listEl);
    setCursorAtTextOffset(newBlock, currentOffset);

    modifiedElementId = newBlock.id;
    newElement = newBlock;
    self.selectionManager.currentSelection = window.getSelection();

    return { modifiedElementId, newElement };
  }

export async function _mergeBlocksIntoList(self: any, paragraphs: any, listType: any) {
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
    const originalParagraphsHTML = paragraphs.map((p: any) => p.outerHTML);
    const extraIds = paragraphs.slice(1).map((p: any) => p.id);

    // Record undo
    if (self.undoManager) {
      self.undoManager.recordFormat(
        firstP.id,
        // Undo: list → paragraphs (restore originals)
        (el: any) => {
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
        (el: any) => {
          const parent = el.parentNode;
          const list = document.createElement(listType);
          // Gather all the paragraphs (first el + extras by ID)
          const allParas = [el, ...extraIds.map((id: any) => document.getElementById(id)).filter(Boolean)];
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
        self.currentBookId,
        0
      );
    }

    // Insert list where first paragraph was, remove all paragraphs
    firstP.parentNode.insertBefore(listEl, firstP);
    for (const p of paragraphs) {
      p.remove();
    }

    // Save list to IndexedDB
    if (self.saveToIndexedDBCallback) {
      await self.saveToIndexedDBCallback(listEl.id, listEl.outerHTML);
    }

    // Delete extra paragraphs from IndexedDB
    if (self.deleteFromIndexedDBCallback) {
      for (const id of extraIds) {
        await self.deleteFromIndexedDBCallback(id);
      }
    }

    self.selectionManager.currentSelection = window.getSelection();
    const firstLi = listEl.querySelector("li");
    if (firstLi) setCursorAtTextOffset(firstLi, 0);

    return { modifiedElementId: listEl.id, newElement: listEl };
  }

export async function handleRemoveList(self: any, parentElement: any) {
    let modifiedElementId = null;
    let newElement = null;

    // Capture cursor offset before any DOM changes
    const sel = self.selectionManager.currentSelection;
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
      const li: any = listItems[i];
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
        const prevId = paragraphs[i - 1]!.id;
        const afterId = findNextElementId(listEl);
        setElementIds(p, prevId, afterId, self.currentBookId);
      }

      paragraphs.push(p);
    }

    // Record for undo/redo
    if (self.undoManager) {
      const oldListHTML = listEl.outerHTML;
      const listId = listEl.id;
      const extraParagraphIds = paragraphs.slice(1).map((p: any) => p.id);

      self.undoManager.recordFormat(
        listId,
        // Undo: paragraphs → list (restore original)
        (el: any) => {
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
        (el: any) => {
          // el is the list; unwrap again
          const items = Array.from(el.querySelectorAll(":scope > li"));
          const ps = [];
          for (let i = 0; i < items.length; i++) {
            const newP = document.createElement("p");
            newP.innerHTML = (items[i] as any).innerHTML || "\u00A0";
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
        self.currentBookId,
        0
      );
    }

    // Insert all paragraphs before the list, then remove the list
    for (const p of paragraphs) {
      listParent.insertBefore(p, listEl);
    }
    listParent.removeChild(listEl);

    // Restore cursor in the paragraph that corresponds to the li the cursor was in
    const targetParagraph: any = paragraphs[cursorLiIndex] || paragraphs[0];
    setCursorAtTextOffset(targetParagraph, cursorOffset);

    modifiedElementId = paragraphs[0]!.id;
    newElement = paragraphs[0];

    self.selectionManager.currentSelection = window.getSelection();

    // Save all paragraphs to IndexedDB
    if (self.saveToIndexedDBCallback) {
      for (const p of paragraphs) {
        if (p.id) {
          await self.saveToIndexedDBCallback(p.id, p.outerHTML);
        }
      }
    }

    // Delete the original list from IndexedDB (only if there were extra items)
    // The first paragraph inherited the list's ID, so that record gets updated above.
    // Extra paragraphs are new records. No separate delete needed since the ID was reused.

    return { modifiedElementId, newElement };
  }
