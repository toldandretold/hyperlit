/**
 * Extract Footnote IDs Utility
 *
 * Extracts footnote IDs from HTML content for storing in nodes.footnotes.
 * New format: id on the <sup> element directly.
 * Old format (backwards compat): href="#footnoteId" on nested <a> element.
 */

/**
 * Extract footnote IDs from HTML content
 *
 * New format: <sup fn-count-id="1" id="footnoteId" class="footnote-ref">1</sup>
 * Old format: <sup fn-count-id="1" id="..."><a class="footnote-ref" href="#footnoteId">1</a></sup>
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

  // New format: sup with class="footnote-ref" and id attribute
  element.querySelectorAll('sup.footnote-ref[id]').forEach(sup => {
    const footnoteId = sup.id;
    if (footnoteId && !seen.has(footnoteId) && (footnoteId.includes('_Fn') || footnoteId.includes('Fn'))) {
      footnoteIds.push(footnoteId);
      seen.add(footnoteId);
    }
  });

  // Old format fallback: anchor href inside sup
  element.querySelectorAll('sup[fn-count-id] a.footnote-ref, a.footnote-ref').forEach(link => {
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
