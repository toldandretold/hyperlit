/**
 * Content Estimation Utilities
 * Estimates node count for paste operations to determine routing
 */

/**
 * Estimate how many nodes a paste operation will create
 * Used to route between small paste (inline) and large paste (batch) handlers
 *
 * @param {string} content - Content to estimate (HTML or plain text)
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

    const blockTags = new Set([
      'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'DIV', 'PRE', 'BLOCKQUOTE', 'LI',
      'TABLE', 'UL', 'OL', 'FIGURE', 'SECTION', 'ARTICLE'
    ]);

    // Count block-level elements
    count += tempDiv.querySelectorAll(
      'p, h1, h2, h3, h4, h5, h6, div, pre, blockquote, li'
    ).length;

    // For block elements containing <br> tags, count non-empty text parts
    // instead of raw <br> count (matches how parseHtmlToBlocks splits content)
    let inlineHTML = '';
    tempDiv.childNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE && blockTags.has(node.tagName)) {
        const brParts = node.innerHTML.split(/<br\s*\/?>/i);
        if (brParts.length > 1) {
          const nonEmptyParts = brParts.filter(p => p.trim()).length;
          if (nonEmptyParts > 1) {
            count += nonEmptyParts - 1; // block itself already counted as 1
          }
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        inlineHTML += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE && !blockTags.has(node.tagName)) {
        inlineHTML += node.outerHTML;
      }
    });

    // For top-level non-block content (inline elements + <br> tags, like Safari paste),
    // split on <br> and count non-empty text segments
    if (inlineHTML.trim()) {
      const segments = inlineHTML.split(/<br\s*\/?>/i).filter(s => s.trim());
      count += segments.length;
    }

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

/**
 * Determine if content should be handled as small paste
 * @param {number} nodeCount - Estimated node count
 * @param {number} threshold - Threshold for small paste (default 20)
 * @returns {boolean} - True if small paste
 */
export function isSmallPaste(nodeCount, threshold = 20) {
  return nodeCount <= threshold;
}
