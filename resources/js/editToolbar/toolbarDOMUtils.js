/**
 * Toolbar DOM Utility Functions
 *
 * Pure utility functions for DOM manipulation and traversal used by the EditToolbar.
 * These functions have no dependencies on class state and can be used independently.
 */

/**
 * Check if element or any of its parents has the specified tag
 * @param {Element} element - The element to check
 * @param {string} tagName - The tag name to search for (e.g., "STRONG", "H1")
 * @returns {boolean}
 */
export function hasParentWithTag(element, tagName) {
  if (!element) return false;

  if (element.tagName === tagName) {
    return true;
  }

  return element.parentNode && element.parentNode.nodeType === 1
    ? hasParentWithTag(element.parentNode, tagName)
    : false;
}

/**
 * Find parent element with the specified tag
 * @param {Element} element - The element to start from
 * @param {string} tagName - The tag name to find
 * @returns {Element|null}
 */
export function findParentWithTag(element, tagName) {
  if (!element) return null;

  if (element.tagName === tagName) {
    return element;
  }

  return element.parentNode && element.parentNode.nodeType === 1
    ? findParentWithTag(element.parentNode, tagName)
    : null;
}

/**
 * Check if an element is a block-level element
 * @param {Element} element - The element to check
 * @returns {boolean}
 */
export function isBlockElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  const blockElements = [
    "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "UL", "OL", "LI", "TABLE",
    "TR", "TD", "TH", "SECTION", "ARTICLE", "ASIDE",
    "HEADER", "FOOTER", "MAIN", "NAV", "FIGURE", "FIGCAPTION"
  ];

  return blockElements.includes(element.tagName);
}

/**
 * Get all block elements that intersect with a range
 * @param {Range} range - The range to check
 * @returns {Array<Element>}
 */
export function getBlockElementsInRange(range) {
  const blockElements = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (isBlockElement(node) && range.intersectsNode(node)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    blockElements.push(node);
  }

  return blockElements;
}

/**
 * Select across multiple elements
 * @param {Array<{element: Element}>} elements - Array of element objects
 */
export function selectAcrossElements(elements) {
  if (elements.length === 0) return;

  const range = document.createRange();
  range.setStartBefore(elements[0].element);
  range.setEndAfter(elements[elements.length - 1].element);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Get all elements with IDs in a selection range
 * @param {Range} range - The range to search
 * @returns {Array<Element>}
 */
export function getElementsInSelectionRange(range) {
  const elements = [];
  const iterator = document.createNodeIterator(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (node.id && range.intersectsNode(node)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    }
  );

  let node;
  while ((node = iterator.nextNode())) {
    elements.push(node);
  }
  return elements;
}

/**
 * Find the closest block-level parent element
 * @param {Element} element - The element to start from
 * @returns {Element|null}
 */
export function findClosestBlockParent(element) {
  if (!element) return null;

  const blockElements = [
    "P",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "BLOCKQUOTE",
    "PRE",
    "UL",
    "OL",
    "LI",
    "TABLE",
    "TR",
    "TD",
    "TH",
  ];

  if (blockElements.includes(element.tagName)) {
    // Skip chunk divs - they're containers, not content blocks that should be formatted/replaced
    if (element.tagName === "DIV" && element.classList?.contains('chunk')) {
      return element.parentNode && element.parentNode.nodeType === 1
        ? findClosestBlockParent(element.parentNode)
        : null;
    }
    return element;
  }

  return element.parentNode && element.parentNode.nodeType === 1
    ? findClosestBlockParent(element.parentNode)
    : null;
}

/**
 * Get the text offset of the cursor within an element
 * @param {Element} element - The containing element
 * @param {Node} container - The node containing the cursor
 * @param {number} offset - The offset within the container
 * @returns {number}
 */
export function getTextOffsetInElement(element, container, offset) {
  if (!element || !container) return 0;

  const range = document.createRange();
  range.setStart(element, 0);
  range.setEnd(container, offset);

  const textBeforeCursor = range.toString();
  return textBeforeCursor.length;
}

/**
 * Set cursor to a specific text offset within an element
 * @param {Element} element - The element to set cursor in
 * @param {number} textOffset - The text offset position
 * @param {Selection} [selection] - Optional selection object (defaults to window.getSelection())
 */
export function setCursorAtTextOffset(element, textOffset, selection = null) {
  if (!element) return;

  const sel = selection || window.getSelection();

  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let currentOffset = 0;
  let targetNode = null;
  let targetOffset = 0;

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const textLength = textNode.textContent.length;

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
      targetOffset = lastTextNode.textContent.length;
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
 * @param {Element} element - The element to search
 * @returns {Node|null}
 */
export function getLastTextNode(element) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let lastTextNode = null;
  while (walker.nextNode()) {
    lastTextNode = walker.currentNode;
  }

  return lastTextNode;
}

/**
 * Get the first text node in an element
 * @param {Element} element - The element to search
 * @returns {Node|null}
 */
export function getFirstTextNode(element) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  return walker.nextNode();
}

/**
 * Find the closest list item parent
 * @param {Element} element - The element to start from
 * @returns {Element|null}
 */
export function findClosestListItem(element) {
  if (!element) return null;

  while (element && element !== document.body) {
    if (element.tagName === "LI") {
      return element;
    }
    element = element.parentElement;
  }

  return null;
}
