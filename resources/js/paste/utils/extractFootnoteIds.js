/**
 * Extract Footnote IDs Utility
 *
 * Extracts footnote data from HTML content for storing in nodes.footnotes.
 * Returns objects with {id, marker} to support non-numeric markers (*, †, 23a, etc.)
 *
 * New format: id on the <sup> element directly.
 * Old format (backwards compat): href="#footnoteId" on nested <a> element.
 */

/**
 * Extract footnote data from HTML content
 *
 * New format: <sup fn-count-id="1" id="footnoteId" class="footnote-ref">1</sup>
 * Old format: <sup fn-count-id="1" id="..."><a class="footnote-ref" href="#footnoteId">1</a></sup>
 *
 * @param {string} htmlContent - HTML string to extract from
 * @returns {{id: string, marker: string}[]} - Array of unique footnote objects
 */
export function extractFootnoteIdsFromHtml(htmlContent) {
  if (!htmlContent) return [];

  const temp = document.createElement('div');
  temp.innerHTML = htmlContent;

  return extractFootnoteIdsFromElement(temp);
}

/**
 * Extract footnote data from a DOM element
 *
 * @param {HTMLElement} element - DOM element to extract from
 * @returns {{id: string, marker: string}[]} - Array of unique footnote objects
 */
export function extractFootnoteIdsFromElement(element) {
  if (!element) return [];

  const footnotes = [];
  const seen = new Set();

  // New format: sup with class="footnote-ref" and id attribute
  element.querySelectorAll('sup.footnote-ref[id]').forEach(sup => {
    const footnoteId = sup.id;
    const marker = sup.getAttribute('fn-count-id') || '';
    if (footnoteId && !seen.has(footnoteId) && (footnoteId.includes('_Fn') || footnoteId.includes('Fn'))) {
      footnotes.push({ id: footnoteId, marker: marker });
      seen.add(footnoteId);
    }
  });

  // Old format fallback: anchor href inside sup
  element.querySelectorAll('sup[fn-count-id] a.footnote-ref, a.footnote-ref').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;

    const footnoteId = href.replace(/^#/, '');
    const sup = link.closest('sup');
    const marker = sup ? (sup.getAttribute('fn-count-id') || '') : '';
    if (footnoteId && !seen.has(footnoteId) && (footnoteId.includes('_Fn') || footnoteId.includes('Fn'))) {
      footnotes.push({ id: footnoteId, marker: marker });
      seen.add(footnoteId);
    }
  });

  return footnotes;
}
