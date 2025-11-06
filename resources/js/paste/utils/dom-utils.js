/**
 * DOM Manipulation Utilities
 * Common DOM operations used across paste handlers and processors
 */

/**
 * Check if an element is a block-level element
 * @param {string} tagName - Tag name to check
 * @returns {boolean} - True if block-level element
 */
export function isBlockElement(tagName) {
  const blockTags = [
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'DIV', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
    'PRE', 'TABLE', 'FIGURE', 'SECTION',
    'ARTICLE', 'HEADER', 'FOOTER'
  ];
  return blockTags.includes(tagName.toUpperCase());
}

/**
 * Replace an element's tag while preserving content and attributes
 * @param {HTMLElement} el - Element to replace
 * @param {string} newTagName - New tag name
 * @param {Document} doc - Document context
 * @returns {HTMLElement} - New element
 */
export function replaceTag(el, newTagName, doc = document) {
  const newEl = doc.createElement(newTagName);

  // Copy attributes (except style and class)
  for (const { name, value } of el.attributes) {
    if (name !== "style" && name !== "class") {
      newEl.setAttribute(name, value);
    }
  }

  // Move children
  while (el.firstChild) {
    newEl.appendChild(el.firstChild);
  }

  el.replaceWith(newEl);
  return newEl;
}

/**
 * Unwrap an element, moving its children to its parent
 * @param {HTMLElement} el - Element to unwrap
 */
export function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;

  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }

  el.remove();
}

/**
 * Wrap loose inline nodes in a container element
 * Useful for ensuring all content is in proper block-level containers
 * @param {HTMLElement} container - Container to process
 * @param {Document} doc - Document context
 */
export function wrapLooseNodes(container, doc = document) {
  const blockTags = /^(P|H[1-6]|BLOCKQUOTE|UL|OL|LI|PRE|DIV|TABLE|FIGURE)$/;
  const nodesToProcess = Array.from(container.childNodes);
  let currentWrapper = null;

  for (const node of nodesToProcess) {
    const isBlock = node.nodeType === Node.ELEMENT_NODE && blockTags.test(node.tagName);

    if (isBlock) {
      currentWrapper = null;
      continue;
    }

    // Skip empty text nodes
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '') {
      continue;
    }

    // Create wrapper if needed
    if (!currentWrapper) {
      currentWrapper = doc.createElement('p');
      container.insertBefore(currentWrapper, node);
    }

    currentWrapper.appendChild(node);
  }
}

/**
 * Create a temporary DOM element from HTML string
 * @param {string} html - HTML content
 * @returns {HTMLElement} - Temporary div containing parsed HTML
 */
export function createTempDOM(html) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  return tempDiv;
}

/**
 * Check if a URL is a real link (not javascript or invalid)
 * @param {string} href - URL to check
 * @returns {boolean} - True if real link
 */
export function isRealLink(href) {
  if (!href) return false;

  // Allow http/https links
  if (/^https?:\/\//i.test(href)) return true;

  // Allow valid internal links (# followed by actual ID, not javascript)
  if (/^#[a-zA-Z][\w-]*$/.test(href)) return true;

  // Reject javascript: links
  if (/^javascript:/i.test(href)) return false;

  // Reject empty hash or hash with only whitespace/special chars
  if (/^#\s*$/.test(href) || /^#[^\w]/.test(href)) return false;

  return false;
}

/**
 * Remove empty block elements that have no content
 * @param {HTMLElement} container - Container to clean
 */
export function removeEmptyBlocks(container) {
  container.querySelectorAll("p, blockquote, h1, h2, h3, li").forEach((el) => {
    if (
      !el.textContent.trim() &&
      !el.querySelector("img") &&
      !el.querySelector("a[id^='pasted-']")
    ) {
      el.remove();
    }
  });
}

/**
 * Strip attributes from elements (style, class, id with conditions)
 * @param {HTMLElement} container - Container to process
 * @param {string} idPrefix - ID prefix to preserve (e.g., 'pasted-')
 */
export function stripAttributes(container, idPrefix = '') {
  container.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("style");
    el.removeAttribute("class");

    if (el.id && !el.id.startsWith(idPrefix)) {
      el.removeAttribute("id");
    }

    // Always strip data-node-id to force regeneration for correct positioning
    el.removeAttribute("data-node-id");
  });
}

/**
 * Group consecutive inline elements together in paragraph wrappers
 * Prevents individual wrapping of inline elements when pasting
 * @param {HTMLElement} container - Container to process
 * @param {Document} doc - Document context
 */
export function groupInlineElements(container, doc = document) {
  const looseInlineElements = Array.from(container.childNodes).filter(node =>
    node.nodeType === Node.ELEMENT_NODE &&
    node.tagName &&
    !isBlockElement(node.tagName)
  );

  if (looseInlineElements.length === 0) return;

  let currentWrapper = null;
  const nodesToProcess = Array.from(container.childNodes);

  nodesToProcess.forEach(node => {
    // Skip if node has been moved already
    if (!container.contains(node)) return;

    const isLooseInline = node.nodeType === Node.ELEMENT_NODE &&
                         node.tagName &&
                         !isBlockElement(node.tagName);

    const isTextWithContent = node.nodeType === Node.TEXT_NODE &&
                             node.textContent.trim();

    if (isLooseInline || isTextWithContent) {
      // Continue using current wrapper or create new one
      if (!currentWrapper || !container.contains(currentWrapper)) {
        currentWrapper = doc.createElement('p');
        container.insertBefore(currentWrapper, node);
      }
      currentWrapper.appendChild(node);
    } else if (node.nodeType === Node.ELEMENT_NODE && isBlockElement(node.tagName)) {
      // Hit a block element - reset wrapper
      currentWrapper = null;
    }
  });
}
