/**
 * Text Normalization Utilities
 * Handles smart quotes, nbsp, whitespace normalization
 */

/**
 * Normalize smart quotes and backticks to regular quotes
 * @param {string} text - Text to normalize
 * @returns {string} - Normalized text
 */
export function normalizeQuotes(text) {
  if (!text) return text;

  return text
    .replace(/'/g, "'")  // Smart single quote (left)
    .replace(/'/g, "'")  // Smart single quote (right)
    .replace(/"/g, '"')  // Smart double quote (left)
    .replace(/"/g, '"')  // Smart double quote (right)
    .replace(/`/g, "'"); // Backticks to regular single quotes
}

/**
 * Normalize non-breaking spaces and Apple-converted spaces
 * @param {string} html - HTML content to normalize
 * @returns {string} - Normalized HTML
 */
export function normalizeSpaces(html) {
  if (!html) return html;

  return html
    .replace(/<span class="Apple-converted-space">\s*&nbsp;\s*<\/span>/g, ' ')
    .replace(/<span class="Apple-converted-space">\s*<\/span>/g, ' ')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Full normalization pipeline for pasted content
 * @param {string} text - Content to normalize
 * @param {boolean} isHtml - Whether content is HTML
 * @returns {string} - Fully normalized content
 */
export function normalizeContent(text, isHtml = false) {
  if (!text) return text;

  let normalized = normalizeQuotes(text);

  if (isHtml) {
    normalized = normalizeSpaces(normalized);
  }

  return normalized;
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - HTML-escaped text
 */
export function escapeHtml(text) {
  if (!text) return text;

  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
