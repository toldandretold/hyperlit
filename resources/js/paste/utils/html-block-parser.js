/**
 * HTML Block Parsing Utility
 * Parses HTML content into individual block-level elements
 *
 * Features:
 * - Identifies block-level vs inline elements
 * - Splits content on <br> tags (for bibliographies)
 * - Wraps loose text nodes in <p> tags
 * - Preserves document structure
 */

/**
 * Check if an element is a block-level element
 * @param {string} tagName - Tag name to check
 * @returns {boolean} - True if block-level element
 */
export function isBlockElement(tagName) {
  const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'BLOCKQUOTE',
                     'UL', 'OL', 'LI', 'PRE', 'TABLE', 'FIGURE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER'];
  return blockTags.includes(tagName.toUpperCase());
}

/**
 * Parse HTML content into individual block elements
 * Splits on block-level elements and <br> tags, wraps loose text
 *
 * @param {string} htmlContent - HTML content to parse
 * @returns {Array<string>} - Array of block-level HTML strings
 */
export function parseHtmlToBlocks(htmlContent) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;

  const blocks = [];

  // The complex div-to-p logic has been moved to assimilateHTML.
  // This function now focuses on splitting into blocks and wrapping loose text.

  // Get direct children, INCLUDING text nodes
  Array.from(tempDiv.childNodes).forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // This is a block-level element
      const child = node;
      child.removeAttribute('id'); // Remove any conflicting IDs

      // Check if this element contains multiple <br> separated entries (common in bibliographies)
      const innerHTML = child.innerHTML;
      const brSeparatedParts = innerHTML.split(/<br\s*\/?>/i);

      // Don't split on <br> if:
      // 1. The element itself is a block element that shouldn't be split (table, ul, ol, etc.)
      // 2. The content contains nested block elements
      const isUnsplittableBlock = /^(TABLE|UL|OL|DIV)$/.test(child.tagName);
      const containsBlockElements = /<(?:table|div|section|ul|ol)/i.test(innerHTML);

      if (brSeparatedParts.length > 1 && !isUnsplittableBlock && !containsBlockElements) {
        // Split on <br> tags - each part becomes a separate block
        brSeparatedParts.forEach(part => {
          const trimmedPart = part.trim();
          if (trimmedPart) {
            // Use a wrapper div to parse the content (browser auto-corrects invalid nesting)
            const wrapper = document.createElement('div');
            wrapper.innerHTML = trimmedPart;

            // Extract all resulting nodes as separate blocks
            Array.from(wrapper.childNodes).forEach(node => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // This is an element - use it as-is
                blocks.push(node.outerHTML);
              } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                // Loose text - wrap in the parent element type
                blocks.push(`<${child.tagName.toLowerCase()}>${node.textContent.trim()}</${child.tagName.toLowerCase()}>`);
              }
            });
          }
        });
      } else {
        // No <br> tags - use the whole element as one block
        blocks.push(child.outerHTML);
      }
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      // This is a "loose" text node that resulted from unwrapping. Wrap it in a <p> tag.
      blocks.push(`<p>${node.textContent.trim()}</p>`);

    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName && !isBlockElement(node.tagName)) {
      // This is a loose inline element (a, span, i, b, etc.) - wrap it in a <p> tag.
      blocks.push(`<p>${node.outerHTML}</p>`);
    }
  });

  // If no block children were found, but there's content, wrap the whole thing in a <p>.
  if (blocks.length === 0 && htmlContent.trim()) {
    blocks.push(`<p>${htmlContent}</p>`);
  }

  return blocks;
}
