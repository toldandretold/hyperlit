/**
 * DOM Helper Utilities for Paste Operations
 *
 * Helper functions for DOM manipulation and node counting during paste.
 */

/**
 * Estimate how many nodes a paste operation will create
 * @param {string} content - Content to paste (HTML or plain text)
 * @returns {number} - Estimated node count
 */
export function estimatePasteNodeCount(content) {
  if (typeof content !== 'string') {
    return 1;
  }

  // Quick & dirty HTML detection
  const isHTML = /<([a-z]+)(?:\s[^>]*)?>/i.test(content);

  if (isHTML) {
    // SECURITY: Use DOMParser instead of innerHTML to prevent XSS
    // DOMParser creates an inert document that doesn't execute scripts or event handlers
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    const tempDiv = doc.body;

    let count = 0;

    // Count block-level elements
    count +=
      tempDiv.querySelectorAll(
        'p, h1, h2, h3, h4, h5, h6, div, pre, blockquote, li'
      ).length;

    // Count <br> as its own node
    count += tempDiv.querySelectorAll('br').length;

    // Count top-level text fragments as paragraphs
    tempDiv.childNodes.forEach(node => {
      if (
        node.nodeType === Node.TEXT_NODE &&
        node.textContent.trim()
      ) {
        const paras = node.textContent
          .split(/\n\s*\n/) // split on blank lines
          .filter(p => p.trim());
        count += paras.length;
      }
    });

    return Math.max(1, count);
  } else {
    // Plain text: first try splitting on blank lines
    const paragraphs = content
      .split(/\n\s*\n/)
      .filter(p => p.trim());

    if (paragraphs.length > 1) {
      return paragraphs.length;
    }

    // Fallback: split on every newline
    const lines = content
      .split('\n')
      .filter(line => line.trim());

    return Math.max(1, lines.length);
  }
}

// This function is no longer used - saveCurrentParagraph is now in hyperciteHandler.js
// Kept for reference but commented out to avoid duplication
//
// /**
//  * Save the current paragraph after a paste operation
//  * Used by hypercite handler to persist inline citation
//  */
// export async function saveCurrentParagraph() {
//   // Import dynamically to avoid circular dependency
//   const { queueNodeForSave } = await import('../../divEditor.js');
//
//   const selection = window.getSelection();
//   if (selection.rangeCount > 0) {
//     const range = selection.getRangeAt(0);
//     let currentElement = range.startContainer;
//     if (currentElement.nodeType !== Node.ELEMENT_NODE) {
//       currentElement = currentElement.parentElement;
//     }
//
//     // Find the closest block element (paragraph, pre, blockquote, etc.)
//     let blockElement = currentElement.closest('p, pre, blockquote, h1, h2, h3, h4, h5, h6');
//
//     if (blockElement && blockElement.id) {
//       console.log("Manually saving block element:", blockElement.id, blockElement.tagName);
//       // Manually save the element to IndexedDB
//       queueNodeForSave(blockElement.id, 'update');
//     }
//   }
// }
