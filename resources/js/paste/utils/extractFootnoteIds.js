/**
 * Extract Footnote IDs Utility
 *
 * Extracts footnote IDs from HTML content for storing in nodes.footnotes.
 * Uses canonical format: href="#footnoteId" on the <a> element.
 */

/**
 * Extract footnote IDs from HTML content
 *
 * Looks for href attribute on footnote links inside <sup> elements.
 * Canonical format: <sup fn-count-id="1" id="footnoteIdref"><a class="footnote-ref" href="#footnoteId">1</a></sup>
 *
 * @param {string} htmlContent - HTML string to extract from
 * @returns {string[]} - Array of unique footnote IDs
 */
export function extractFootnoteIdsFromHtml(htmlContent) {
  if (!htmlContent) return [];

  const temp = document.createElement('div');
  temp.innerHTML = htmlContent;

  return extractFootnoteIdsFromElement(temp);
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

  // Find all footnote links (canonical format uses href)
  element.querySelectorAll('sup[fn-count-id] a, a.footnote-ref').forEach(link => {
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
