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
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;

    let count = 0;

    // Count block-level elements
    count += tempDiv.querySelectorAll(
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

/**
 * Determine if content should be handled as small paste
 * @param {number} nodeCount - Estimated node count
 * @param {number} threshold - Threshold for small paste (default 20)
 * @returns {boolean} - True if small paste
 */
export function isSmallPaste(nodeCount, threshold = 20) {
  return nodeCount <= threshold;
}
