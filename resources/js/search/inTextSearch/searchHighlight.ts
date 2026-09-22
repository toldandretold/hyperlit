// searchHighlight.js - Handles applying and clearing search result highlights

import { log, verbose } from "../../utilities/logger";

/**
 * Get all text nodes within an element
 * @param {HTMLElement} element - Root element to traverse
 * @returns {Array<Node>} Array of text nodes
 */
function getTextNodes(element: any) {
  const textNodes: any[] = [];
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
function findPositionsInDOM(rootElement: any, startChar: any, endChar: any) {
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
function wrapRangeWithElement(startNode: any, startOffset: any, endNode: any, endOffset: any, wrapElement: any) {
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

    const contents = range.extractContents();
    wrapElement.appendChild(contents);
    range.insertNode(wrapElement);
  } catch (error) {
    log.error(`SearchHighlight: Failed to wrap range — ${(error as Error)?.message}`, '/search/inTextSearch/searchHighlight');
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
export function applySearchHighlight(element: any, charStart: any, charEnd: any, isCurrent = false, markId: any = null) {
  if (!element) {
    log.error('SearchHighlight: No element provided', '/search/inTextSearch/searchHighlight');
    return null;
  }

  const positions = findPositionsInDOM(element, charStart, charEnd);
  if (!positions) {
    verbose.content(`SearchHighlight: no DOM positions for ${charStart}-${charEnd}`, '/search/inTextSearch/searchHighlight');
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
 * Mark a whole node as a semantic match.
 *
 * Semantic mode has no character offsets to wrap — the server ranks whole nodes
 * by cosine distance, so what matched IS the paragraph. This sets a class and a
 * couple of data attributes on the node element and touches nothing inside it.
 *
 * That is deliberately unlike the exact-match path: applySearchHighlight does
 * `range.extractContents()` + `insertNode`, real surgery on live book DOM. Fine
 * for a read-mode find bar, but every mutation avoided is one less thing for the
 * divEditor MutationObserver to ingest — and here there is nothing to gain from
 * it, since the whole node is the hit.
 *
 * @param {HTMLElement} element - The node element (id = its startLine)
 * @param {number} matchPercent - Floor-rescaled match %, rendered in the gutter
 * @param {boolean} isCurrent - Whether this is the focused match
 * @param {number} index - Match index, for addressing it later
 */
export function applySemanticNodeHighlight(
  element: HTMLElement | null,
  matchPercent: number,
  isCurrent = false,
  index = 0,
): HTMLElement | null {
  if (!element) return null;

  element.classList.add('semantic-match');
  element.classList.toggle('current', isCurrent);
  element.dataset.semanticMatch = String(matchPercent);
  element.dataset.semanticIndex = String(index);

  return element;
}

/**
 * Remove every semantic match marker. Must run on close AND on every mode
 * switch — a leftover tint would read as a hit in the other mode.
 */
export function clearSemanticHighlights() {
  document.querySelectorAll('.semantic-match').forEach(el => {
    el.classList.remove('semantic-match', 'current');
    delete (el as HTMLElement).dataset.semanticMatch;
    delete (el as HTMLElement).dataset.semanticIndex;
  });
}

/**
 * Toggle search mode class on body
 * @param {boolean} enabled - Whether search mode is active
 */
export function setSearchMode(enabled: any) {
  if (enabled) {
    document.body.classList.add('search-mode');
  } else {
    document.body.classList.remove('search-mode');
  }
}
