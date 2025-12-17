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
  // NOTE: Using innerHTML here is safe because content is already sanitized
  // before reaching this function (sanitized in largePasteHandler.js)
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;

  console.log('🔍 parseHtmlToBlocks received childNodes:', tempDiv.childNodes.length);
  Array.from(tempDiv.childNodes).slice(0, 10).forEach((node, i) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      console.log(`  [${i}] ELEMENT: ${node.tagName} - block? ${isBlockElement(node.tagName)}`);
    } else if (node.nodeType === Node.TEXT_NODE) {
      console.log(`  [${i}] TEXT: "${node.textContent.substring(0, 30)}..."`);
    }
  });

  const blocks = [];
  let inlineAccumulator = []; // Accumulate consecutive inline elements

  // Helper to flush accumulated inline elements
  const flushInlineAccumulator = () => {
    if (inlineAccumulator.length > 0) {
      const combinedHTML = inlineAccumulator.join('');
      console.log(`  ✅ Flushing ${inlineAccumulator.length} inline elements into one <p>`);
      blocks.push(`<p>${combinedHTML}</p>`);
      inlineAccumulator = [];
    }
  };

  // The complex div-to-p logic has been moved to assimilateHTML.
  // This function now focuses on splitting into blocks and wrapping loose text.

  // Get direct children, INCLUDING text nodes
  Array.from(tempDiv.childNodes).forEach((node, nodeIndex) => {
    if (node.nodeType === Node.ELEMENT_NODE && isBlockElement(node.tagName)) {
      // This is a block-level element - flush any pending inline content first
      flushInlineAccumulator();

      const child = node;
      child.removeAttribute('id'); // Remove any conflicting IDs

      // Check if this element contains multiple <br> separated entries (common in bibliographies)
      const innerHTML = child.innerHTML;
      const brSeparatedParts = innerHTML.split(/<br\s*\/?>/i);

      if (nodeIndex < 10) {
        console.log(`  Processing node ${nodeIndex} (${child.tagName}): brParts=${brSeparatedParts.length}, innerHTML="${innerHTML.substring(0, 60)}..."`);
      }

      // Don't split on <br> if:
      // 1. The element itself is a block element that shouldn't be split (table, ul, ol, etc.)
      // 2. The content contains nested block elements
      const isUnsplittableBlock = /^(TABLE|UL|OL|DIV)$/.test(child.tagName);
      const containsBlockElements = /<(?:table|div|section|ul|ol)/i.test(innerHTML);

      if (brSeparatedParts.length > 1 && !isUnsplittableBlock && !containsBlockElements) {
        console.log(`    → SPLITTING on <br> tags (${brSeparatedParts.length} parts)`);

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
                // Check if this is a block element or inline element
                if (isBlockElement(node.tagName)) {
                  // Block element - use as-is
                  blocks.push(node.outerHTML);
                } else {
                  // Inline element - wrap in the parent element type
                  blocks.push(`<${child.tagName.toLowerCase()}>${node.outerHTML}</${child.tagName.toLowerCase()}>`);
                }
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
      // This is a "loose" text node - accumulate it with other inline content
      inlineAccumulator.push(node.textContent);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName && !isBlockElement(node.tagName)) {
      // This is a loose inline element (a, span, em, i, b, etc.) - accumulate it
      inlineAccumulator.push(node.outerHTML);
    }
  });

  // Flush any remaining inline content
  flushInlineAccumulator();

  // If no block children were found, but there's content, wrap the whole thing in a <p>.
  if (blocks.length === 0 && htmlContent.trim()) {
    blocks.push(`<p>${htmlContent}</p>`);
  }

  console.log(`🔍 parseHtmlToBlocks returning ${blocks.length} blocks`);
  blocks.slice(0, 10).forEach((block, i) => {
    const preview = block.substring(0, 80).replace(/\n/g, ' ');
    console.log(`  Block ${i}: ${preview}...`);
  });

  return blocks;
}
