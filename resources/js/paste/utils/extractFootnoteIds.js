/**
 * Extract Footnote IDs Utility
 *
 * Extracts footnote IDs from HTML content for storing in nodes.footnotes.
 * Used during paste operations to populate the footnotes array with IDs
 * instead of display numbers.
 */

/**
 * Extract footnote IDs from HTML content
 *
 * Looks for:
 * 1. data-footnote-id attribute on <sup> elements (preferred)
 * 2. href attribute on footnote-ref links (fallback)
 *
 * @param {string} htmlContent - HTML string to extract from
 * @returns {string[]} - Array of unique footnote IDs
 */
export function extractFootnoteIdsFromHtml(htmlContent) {
  if (!htmlContent) return [];

  const temp = document.createElement('div');
  temp.innerHTML = htmlContent;

  const footnoteIds = [];
  const seen = new Set();

  // Method 1: Look for data-footnote-id attribute (preferred)
  temp.querySelectorAll('sup[data-footnote-id]').forEach(sup => {
    const footnoteId = sup.getAttribute('data-footnote-id');
    if (footnoteId && !seen.has(footnoteId)) {
      footnoteIds.push(footnoteId);
      seen.add(footnoteId);
    }
  });

  // Method 2: Look for footnote-ref links (fallback)
  temp.querySelectorAll('sup a.footnote-ref, a.footnote-ref').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;

    const footnoteId = href.replace(/^#/, '');
    // Only add if it looks like a footnote ID (contains _Fn or Fn)
    if (footnoteId && !seen.has(footnoteId) && (footnoteId.includes('_Fn') || footnoteId.includes('Fn'))) {
      footnoteIds.push(footnoteId);
      seen.add(footnoteId);
    }
  });

  return footnoteIds;
}

/**
 * Extract footnote IDs from a DOM element
 *
 * @param {HTMLElement} element - DOM element to extract from
 * @returns {string[]} - Array of unique footnote IDs
 */
export function extractFootnoteIdsFromElement(element) {
  if (!element) return [];

  const footnoteIds = [];
  const seen = new Set();

  // Method 1: Look for data-footnote-id attribute (preferred)
  element.querySelectorAll('sup[data-footnote-id]').forEach(sup => {
    const footnoteId = sup.getAttribute('data-footnote-id');
    if (footnoteId && !seen.has(footnoteId)) {
      footnoteIds.push(footnoteId);
      seen.add(footnoteId);
    }
  });

  // Method 2: Look for footnote-ref links (fallback)
  element.querySelectorAll('sup a.footnote-ref, a.footnote-ref').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;

    const footnoteId = href.replace(/^#/, '');
    if (footnoteId && !seen.has(footnoteId) && (footnoteId.includes('_Fn') || footnoteId.includes('Fn'))) {
      footnoteIds.push(footnoteId);
      seen.add(footnoteId);
    }
  });

  return footnoteIds;
}
