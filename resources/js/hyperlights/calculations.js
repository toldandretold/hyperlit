/**
 * Calculations module - Handles offset calculations and positioning logic
 */

/**
 * Calculate the clean text offset in a container, stripping all HTML elements
 * @param {HTMLElement} container - The container element
 * @param {Node} textNode - The target text node
 * @param {number} offset - The offset within the text node
 * @returns {number} Clean offset without HTML
 */
export function calculateCleanTextOffset(container, textNode, offset) {
  console.log("=== calculateCleanTextOffset Debug ===");
  console.log("Target textNode:", textNode);
  console.log("Target offset:", offset);
  console.log("Target textNode content:", `"${textNode.textContent}"`);

  // Create a range from the start of container to the target position
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(textNode, offset);

  // Get the text content of this range - this automatically strips HTML
  const rangeText = range.toString();
  console.log("Range text:", `"${rangeText}"`);

  // The clean offset is simply the length of the range text
  const cleanOffset = rangeText.length;

  console.log(`Clean offset calculated: ${cleanOffset}`);

  // Verification: create clean container to double-check
  // Remove ALL HTML elements, not just marks, to get truly clean text
  const cleanContainer = container.cloneNode(true);

  // Remove all HTML elements while preserving text content
  const removeAllHtml = (element) => {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );

    const elementsToReplace = [];
    let node;
    while (node = walker.nextNode()) {
      // Skip the root container itself
      if (node !== element) {
        elementsToReplace.push(node);
      }
    }

    // Replace elements with their text content (from innermost to outermost)
    elementsToReplace.reverse().forEach(el => {
      if (el.parentNode) {
        el.parentNode.replaceChild(document.createTextNode(el.textContent), el);
      }
    });
  };

  removeAllHtml(cleanContainer);
  const cleanText = cleanContainer.textContent;
  console.log(`Verification - clean text at offset: "${cleanText.substring(0, cleanOffset)}"`);
  console.log(`Full clean text: "${cleanText}"`);

  return cleanOffset;
}

/**
 * Get relative offset top of element within container
 * @param {HTMLElement} element - The element to measure
 * @param {HTMLElement} container - The container to measure relative to
 * @returns {number} Offset in pixels
 */
export function getRelativeOffsetTop(element, container) {
  let offsetTop = 0;
  while (element && element !== container) {
    offsetTop += element.offsetTop;
    element = element.offsetParent;
  }
  return offsetTop;
}

/**
 * Check if an ID is numerical (including decimals like "1.1")
 * @param {string} id - The ID to check
 * @returns {boolean} True if numerical
 */
export function isNumericalId(id) {
  if (!id) return false;
  return /^\d+(\.\d+)?$/.test(id);
}

/**
 * Find the nearest container with a numerical ID
 * @param {HTMLElement} startElement - Element to start searching from
 * @returns {HTMLElement|null} Container with numerical ID or null
 */
export function findContainerWithNumericalId(startElement) {
  // Start from the element itself or its parent if it's a text node
  let current = startElement;

  // If it's a text node, start from its parent element
  if (current && current.nodeType === 3) {
    current = current.parentElement;
  }

  // Walk up the DOM tree looking for a container with numerical ID
  while (current && current !== document.body && current !== document.documentElement) {
    // Check if current element is one of our target types
    if (current.matches && current.matches("p, blockquote, table, h1, h2, h3, h4, h5, h6, li")) {
      // Check if it has a numerical ID
      if (isNumericalId(current.id)) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return null;
}
