/**
 * List Converter for EditToolbar
 *
 * Handles converting list items to block elements:
 * - Converting list items to blockquote or code blocks
 * - Splitting lists around converted items
 * - Cleaning up empty list items after splits
 */

import {
  findClosestListItem,
  setCursorAtTextOffset,
} from "./toolbarDOMUtils.js";
import {
  setElementIds,
  findPreviousElementId,
  findNextElementId,
} from "../utilities/IDfunctions.js";

/**
 * ListConverter class
 * Handles list item to block element conversions
 */
export class ListConverter {
  constructor(options = {}) {
    this.currentBookId = options.currentBookId || null;
    this.saveToIndexedDBCallback = options.saveToIndexedDBCallback || null;
  }

  /**
   * Convert a list item to a block element (blockquote or code)
   * @param {HTMLElement} listItem - The list item to convert
   * @param {string} blockType - "blockquote" or "code"
   * @returns {HTMLElement|null} The new block element or null
   */
  async convertListItemToBlock(listItem, blockType) {
    const immediateParentList = listItem.parentElement;

    if (
      !immediateParentList ||
      !["UL", "OL"].includes(immediateParentList.tagName)
    ) {
      console.warn("Cannot convert list item - not in a list");
      return null;
    }

    let listWithId = immediateParentList;
    while (listWithId && listWithId !== document.body) {
      if (
        (listWithId.tagName === "UL" || listWithId.tagName === "OL") &&
        listWithId.id
      ) {
        break;
      }
      listWithId = listWithId.parentElement;
    }

    if (!listWithId) {
      console.warn("Cannot convert list item - no parent list with ID found");
      return null;
    }

    console.log(`Converting list item from list with ID: ${listWithId.id}`);

    const newBlock =
      blockType === "blockquote"
        ? document.createElement("blockquote")
        : document.createElement("pre");

    if (blockType === "code") {
      const codeElement = document.createElement("code");
      newBlock.appendChild(codeElement);
      codeElement.textContent = listItem.textContent.trim();
    } else {
      let content = listItem.innerHTML.trim();
      if (content && !content.endsWith("<br>")) {
        content += "<br>";
      }
      newBlock.innerHTML = content;
    }

    const beforeId = findPreviousElementId(listWithId);
    const afterId = findNextElementId(listWithId);
    setElementIds(newBlock, beforeId, afterId, this.currentBookId);

    await this.splitListAndInsertBlock(
      immediateParentList,
      listItem,
      newBlock,
      listWithId
    );

    // Save the new block to IndexedDB
    if (this.saveToIndexedDBCallback) {
      await this.saveToIndexedDBCallback(newBlock.id, newBlock.outerHTML);
    }
    setCursorAtTextOffset(newBlock, 0);

    return newBlock;
  }

  /**
   * Split a list around a specific item and insert a block element
   * @param {HTMLElement} parentList - The immediate parent list
   * @param {HTMLElement} targetItem - The list item to split around
   * @param {HTMLElement} newBlock - The new block element to insert
   * @param {HTMLElement} rootListWithId - The root list with an ID
   */
  async splitListAndInsertBlock(
    parentList,
    targetItem,
    newBlock,
    rootListWithId
  ) {
    const allItems = Array.from(parentList.children);
    const targetIndex = allItems.indexOf(targetItem);

    if (targetIndex === -1) return;

    const itemsBefore = allItems.slice(0, targetIndex);
    const itemsAfter = allItems.slice(targetIndex + 1);

    targetItem.remove(); // Remove the target item first

    if (parentList === rootListWithId) {
      // Simple case: we're splitting the root list directly
      rootListWithId.parentNode.insertBefore(
        newBlock,
        rootListWithId.nextSibling
      );

      if (itemsAfter.length > 0) {
        const newList = document.createElement(parentList.tagName);
        const afterBlockId = findNextElementId(newBlock);
        setElementIds(newList, newBlock.id, afterBlockId, this.currentBookId);

        itemsAfter.forEach((item) => newList.appendChild(item));

        newBlock.parentNode.insertBefore(newList, newBlock.nextSibling);
        if (this.saveToIndexedDBCallback) {
          await this.saveToIndexedDBCallback(newList.id, newList.outerHTML);
        }
      }
      if (this.saveToIndexedDBCallback) {
        await this.saveToIndexedDBCallback(rootListWithId.id, rootListWithId.outerHTML);
      }
    } else {
      // Complex case: nested list
      const pathToRoot = [];
      let currentElement = parentList;
      while (currentElement && currentElement !== rootListWithId) {
        pathToRoot.unshift(currentElement);
        currentElement = currentElement.parentElement;
      }

      let topLevelItem = parentList;
      while (topLevelItem.parentElement !== rootListWithId) {
        topLevelItem = topLevelItem.parentElement;
      }

      const rootItems = Array.from(rootListWithId.children);
      const topLevelIndex = rootItems.indexOf(topLevelItem);

      if (topLevelIndex !== -1) {
        const insertAfter = rootItems[topLevelIndex];
        rootListWithId.parentNode.insertBefore(
          newBlock,
          insertAfter.nextSibling
        );

        if (itemsAfter.length > 0) {
          const newTopLevelItem = document.createElement("li");
          const newNestedList = document.createElement(parentList.tagName);

          itemsAfter.forEach((item) => newNestedList.appendChild(item));
          newTopLevelItem.appendChild(newNestedList);

          const newList = document.createElement(rootListWithId.tagName);
          const afterBlockId = findNextElementId(newBlock);
          setElementIds(newList, newBlock.id, afterBlockId, this.currentBookId);

          newList.appendChild(newTopLevelItem);
          newBlock.parentNode.insertBefore(newList, newBlock.nextSibling);
          if (this.saveToIndexedDBCallback) {
            await this.saveToIndexedDBCallback(newList.id, newList.outerHTML);
          }
        }
      }
      await this.cleanupAfterSplit(rootListWithId);
    }
  }

  /**
   * Clean up empty lists and list items after splitting
   * @param {HTMLElement} rootList - The root list to clean up
   */
  async cleanupAfterSplit(rootList) {
    const emptyLists = rootList.querySelectorAll("ul:empty, ol:empty");
    emptyLists.forEach((list) => list.remove());

    const listItems = rootList.querySelectorAll("li");
    listItems.forEach((li) => {
      const hasContent = li.textContent.trim() !== "";
      const hasNonEmptyChildren = Array.from(li.children).some(
        (child) =>
          child.textContent.trim() !== "" || child.children.length > 0
      );

      if (!hasContent && !hasNonEmptyChildren) {
        li.remove();
      }
    });

    // Save the updated root list
    if (this.saveToIndexedDBCallback) {
      await this.saveToIndexedDBCallback(rootList.id, rootList.outerHTML);
    }
  }

  /**
   * Update the currentBookId (called when book changes)
   */
  setBookId(bookId) {
    this.currentBookId = bookId;
  }
}
