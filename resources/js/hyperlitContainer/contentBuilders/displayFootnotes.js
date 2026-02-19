/**
 * Footnote Content Builder
 * Constructs HTML content for displaying footnotes in the hyperlit container.
 * Footnote text content is rendered separately via subBookLoader (lazy loader pipeline).
 */

import { getDisplayNumber } from '../../footnotes/FootnoteNumberingService.js';

/**
 * Build footnote content section — structural HTML only (sup number + HR).
 * Actual footnote text is loaded asynchronously by subBookLoader in handlePostOpenActions.
 *
 * @param {Object} contentType - The footnote content type object
 * @param {IDBDatabase} db - Unused (kept for signature compatibility)
 * @param {boolean} editModeEnabled - Unused (kept for signature compatibility)
 * @returns {Promise<string>} HTML string for footnote content
 */
export async function buildFootnoteContent(contentType, db = null, editModeEnabled = true) {
  console.time('buildFootnoteContent-total');
  try {
    const { fnCountId } = contentType;
    // footnoteId may be stored as footnoteId or elementId depending on context
    const footnoteId = contentType.footnoteId || contentType.elementId;

    if (!footnoteId) {
      console.error('No footnoteId found in contentType:', contentType);
      return '';
    }

    // Use dynamic display number from FootnoteNumberingService, fallback to fnCountId
    const displayNumber = getDisplayNumber(footnoteId) || fnCountId || '?';

    console.timeEnd('buildFootnoteContent-total');
    return `
      <div class="footnotes-section" data-content-id="${footnoteId}" data-footnote-id="${footnoteId}">
        <div class="footnote-content">
          <sup class="footnote-number" style="font-weight: bold;">${displayNumber}</sup>
        </div>
        <hr style="margin: 2em 0; opacity: 0.5;">
      </div>`;
  } catch (error) {
    console.timeEnd('buildFootnoteContent-total');
    console.error('Error building footnote content:', error);
    const footnoteId = contentType.elementId || 'unknown';
    const fnCountId = contentType.fnCountId || '?';
    const displayNumber = getDisplayNumber(footnoteId) || fnCountId;
    return `
      <div class="footnotes-section" data-content-id="${footnoteId}">
        <sup>${displayNumber}</sup>
        <div class="error">Error loading footnote</div>
        <hr>
      </div>`;
  }
}
