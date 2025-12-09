// searchHighlight.js - Handles applying and clearing search result highlights

/**
 * Get all text nodes within an element
 * @param {HTMLElement} element - Root element to traverse
 * @returns {Array<Node>} Array of text nodes
 */
function getTextNodes(element) {
  const textNodes = [];
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      textNodes.push(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      textNodes.push(...getTextNodes(node));
    }
  }
  return textNodes;
}

/**
 * Find DOM positions for character offsets in an element
 * @param {HTMLElement} rootElement - The element to search within
 * @param {number} startChar - Character offset where match starts
 * @param {number} endChar - Character offset where match ends
 * @returns {Object|null} Object with startNode, startOffset, endNode, endOffset
 */
function findPositionsInDOM(rootElement, startChar, endChar) {
  const textNodes = getTextNodes(rootElement);
  let currentIndex = 0;
  let startNode = null, startOffset = 0;
  let endNode = null, endOffset = 0;

  // Find start position
  for (const node of textNodes) {
    const nodeLength = node.textContent.length;
    if (currentIndex <= startChar && currentIndex + nodeLength > startChar) {
      startNode = node;
      startOffset = startChar - currentIndex;
      break;
    }
    currentIndex += nodeLength;
  }

  // Find end position
  currentIndex = 0;
  for (const node of textNodes) {
    const nodeLength = node.textContent.length;
    if (currentIndex <= endChar && currentIndex + nodeLength >= endChar) {
      endNode = node;
      endOffset = endChar - currentIndex;
      break;
    }
    currentIndex += nodeLength;
  }

  if (startNode && endNode) {
    return { startNode, startOffset, endNode, endOffset };
  }

  return null;
}

/**
 * Wrap a range with an element
 * @param {Node} startNode - Start text node
 * @param {number} startOffset - Offset within start node
 * @param {Node} endNode - End text node
 * @param {number} endOffset - Offset within end node
 * @param {HTMLElement} wrapElement - Element to wrap with
 */
function wrapRangeWithElement(startNode, startOffset, endNode, endOffset, wrapElement) {
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

    const contents = range.extractContents();
    wrapElement.appendChild(contents);
    range.insertNode(wrapElement);
  } catch (error) {
    console.error('SearchHighlight: Failed to wrap range:', error);
  }
}

/**
 * Apply a search highlight to an element at specified character positions
 * @param {HTMLElement} element - The DOM element (e.g., a paragraph)
 * @param {number} charStart - Character offset where match starts
 * @param {number} charEnd - Character offset where match ends
 * @param {boolean} isCurrent - Whether this is the current/focused match
 * @param {string|null} markId - Optional unique ID for the mark element
 * @returns {HTMLElement|null} The created mark element, or null if failed
 */
export function applySearchHighlight(element, charStart, charEnd, isCurrent = false, markId = null) {
  if (!element) {
    console.warn('SearchHighlight: No element provided');
    return null;
  }

  const positions = findPositionsInDOM(element, charStart, charEnd);
  if (!positions) {
    console.warn('SearchHighlight: Could not find positions for', charStart, charEnd);
    return null;
  }

  const mark = document.createElement('mark');
  mark.className = 'search-highlight';
  if (isCurrent) {
    mark.classList.add('current');
  }
  if (markId) {
    mark.id = markId;
  }

  wrapRangeWithElement(
    positions.startNode,
    positions.startOffset,
    positions.endNode,
    positions.endOffset,
    mark
  );

  return mark;
}

/**
 * Clear all search highlights from the document
 */
export function clearSearchHighlights() {
  const marks = document.querySelectorAll('mark.search-highlight');

  marks.forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;

    // Move all children out of the mark
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }

    // Remove the empty mark
    parent.removeChild(mark);

    // Normalize to merge adjacent text nodes
    if (typeof parent.normalize === 'function') {
      parent.normalize();
    }
  });
}

/**
 * Update which search highlight is marked as current
 * @param {number} startLine - The startLine of the current match
 * @param {number} charStart - The charStart of the current match
 */
export function setCurrentHighlight(startLine, charStart) {
  // Remove current class from all
  document.querySelectorAll('mark.search-highlight.current').forEach(mark => {
    mark.classList.remove('current');
  });

  // Find the element by startLine
  const element = document.getElementById(String(startLine));
  if (!element) return;

  // Find marks within this element and mark the right one as current
  const marks = element.querySelectorAll('mark.search-highlight');
  // For now, just mark the first one - we could be more precise by checking char position
  if (marks.length > 0) {
    marks[0].classList.add('current');
  }
}

/**
 * Toggle search mode class on body
 * @param {boolean} enabled - Whether search mode is active
 */
export function setSearchMode(enabled) {
  if (enabled) {
    document.body.classList.add('search-mode');
  } else {
    document.body.classList.remove('search-mode');
  }
}
