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
    // Strip word joiner characters (from previous pastes)
    quotedText = quoteMatch[1].replace(/\u2060/g, '');
  } else {
    // Fallback to just using text before the citation
    const textNodes = Array.from(pasteWrapper.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE);
    if (textNodes.length > 0) {
      // Strip word joiner characters (from previous pastes) then quotes
      quotedText = textNodes[0].textContent.replace(/\u2060/g, '').replace(/^[''""]/, '').replace(/[''""]$/, '');
    }
  }

  return quotedText;
}
