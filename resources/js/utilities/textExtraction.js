/**
 * Text extraction utilities
 * Shared between paste and hyperlights modules
 */

/**
 * Extract quoted text from a paste wrapper element
 * @param {HTMLElement} pasteWrapper - Container element
 * @returns {string} - Cleaned quoted text
 */
export function extractQuotedText(pasteWrapper) {
  let quotedText = "";
  const fullText = pasteWrapper.textContent;
  // Updated regex to handle mixed quote types - match any opening quote with any closing quote

  const quoteMatch = fullText.match(/^[''""]([^]*?)[''""](?=\s*↗|$)/);

  if (quoteMatch && quoteMatch[1]) {
    quotedText = quoteMatch[1];
  } else {
    // Fallback to just using text before the citation
    const textNodes = Array.from(pasteWrapper.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE);
    if (textNodes.length > 0) {
      // Handle mixed quote types by removing any quote from start and end separately
      quotedText = textNodes[0].textContent.replace(/^[''""]/, '').replace(/[''""]$/, '');

    }
  }

  return quotedText;
}
