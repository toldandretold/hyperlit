/**
 * Toolbar DOM Utility Functions
 *
 * Pure utility functions for DOM manipulation and traversal used by the EditToolbar.
 * These functions have no dependencies on class state and can be used independently.
 */

import { STRUCTURAL_BLOCK_TAGS } from '../utilities/blockElements';
import { placeCaretInEmptyListItem } from '../utilities/listItemCaret';

/**
 * Check if element or any of its parents has the specified tag
 */
export function hasParentWithTag(element: Element | null, tagName: string): boolean {
  if (!element) return false;

  if (element.tagName === tagName) {
    return true;
  }

  return element.parentNode && element.parentNode.nodeType === 1
    ? hasParentWithTag(element.parentNode as Element, tagName)
    : false;
}

/**
 * Find parent element with the specified tag
 */
export function findParentWithTag(element: Element | null, tagName: string): Element | null {
  if (!element) return null;

  if (element.tagName === tagName) {
    return element;
  }

  return element.parentNode && element.parentNode.nodeType === 1
    ? findParentWithTag(element.parentNode as Element, tagName)
    : null;
}

/**
 * Check if an element is a block-level element
 */
export function isBlockElement(element: Node | null): boolean {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  return STRUCTURAL_BLOCK_TAGS.has((element as Element).tagName);
}

/**
 * Get all block elements that intersect with a range
 */
export function getBlockElementsInRange(range: Range): Element[] {
  const blockElements: Element[] = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node: Node) => {
        if (isBlockElement(node) && range.intersectsNode(node)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    }
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    blockElements.push(node as Element);
  }

  return blockElements;
}

/**
 * Select across multiple elements
 */
export function selectAcrossElements(elements: Array<{ element: Element }>): void {
  if (elements.length === 0) return;

  const range = document.createRange();
  range.setStartBefore(elements[0]!.element);
  range.setEndAfter(elements[elements.length - 1]!.element);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Get all elements with IDs in a selection range
 */
export function getElementsInSelectionRange(range: Range): Element[] {
  const elements: Element[] = [];
  const iterator = document.createNodeIterator(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node: Node) => {
        if ((node as Element).id && range.intersectsNode(node)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    }
  );

  let node: Node | null;
  while ((node = iterator.nextNode())) {
    elements.push(node as Element);
  }
  return elements;
}

/**
 * Find the closest block-level parent element
 */
export function findClosestBlockParent(element: Element | null): Element | null {
  if (!element) return null;

  if (STRUCTURAL_BLOCK_TAGS.has(element.tagName)) {
    // Skip chunk divs - they're containers, not content blocks that should be formatted/replaced
    if (element.tagName === "DIV" && element.classList?.contains('chunk')) {
      return element.parentNode && element.parentNode.nodeType === 1
        ? findClosestBlockParent(element.parentNode as Element)
        : null;
    }
    return element;
  }

  return element.parentNode && element.parentNode.nodeType === 1
    ? findClosestBlockParent(element.parentNode as Element)
    : null;
}

/**
 * Get the text offset of the cursor within an element
 */
export function getTextOffsetInElement(element: Node | null, container: Node | null, offset: number): number {
  if (!element || !container) return 0;

  const range = document.createRange();
  range.setStart(element, 0);
  range.setEnd(container, offset);

  const textBeforeCursor = range.toString();
  return textBeforeCursor.length;
}

/**
 * Set cursor to a specific text offset within an element
 */
export function setCursorAtTextOffset(element: Element | null, textOffset: number, selection: Selection | null = null): void {
  if (!element) return;

  const sel = selection || window.getSelection();
  if (!sel) return;

  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  let currentOffset = 0;
  let targetNode: Node | null = null;
  let targetOffset = 0;

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const textLength = textNode.textContent?.length ?? 0;

    if (currentOffset + textLength >= textOffset) {
      targetNode = textNode;
      targetOffset = textOffset - currentOffset;
      break;
    }

    currentOffset += textLength;
  }

  if (!targetNode) {
    const lastTextNode = getLastTextNode(element);
    if (lastTextNode) {
      targetNode = lastTextNode;
      targetOffset = lastTextNode.textContent?.length ?? 0;
    } else if (element.tagName === "LI") {
      // Empty list item: a caret at element-offset 0 renders to the LEFT of the
      // bullet/number under `list-style-position: inside`. Anchor it after a
      // zero-width space so it sits right of the marker. See listItemCaret.js.
      placeCaretInEmptyListItem(element as HTMLElement, sel);
      return;
    } else {
      targetNode = element;
      targetOffset = 0;
    }
  }

  if (targetNode) {
    const range = document.createRange();
    range.setStart(
      targetNode,
      Math.min(targetOffset, targetNode.textContent?.length || 0)
    );
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/**
 * Get the last text node in an element
 */
export function getLastTextNode(element: Node): Node | null {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  let lastTextNode: Node | null = null;
  while (walker.nextNode()) {
    lastTextNode = walker.currentNode;
  }

  return lastTextNode;
}

/**
 * Get the first text node in an element
 */
export function getFirstTextNode(element: Node): Node | null {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  return walker.nextNode();
}

/**
 * Replace a DOM element using execCommand('insertHTML') so the change
 * participates in the browser's native undo stack (Cmd+Z / Ctrl+Z).
 */
export function replaceBlockUndoable(oldElement: Element, newOuterHTML: string): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNode(oldElement);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertHTML', false, newOuterHTML);
}

/**
 * Find the closest list item parent
 */
export function findClosestListItem(element: Element | null): Element | null {
  if (!element) return null;

  while (element && element !== document.body) {
    if (element.tagName === "LI") {
      return element;
    }
    element = element.parentElement;
  }

  return null;
}
