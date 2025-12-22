/**
 * Footnote Content Builder
 * Constructs HTML content for displaying footnotes in the hyperlit container
 */

import { book } from '../../app.js';
import { openDatabase } from '../../indexedDB/index.js';
import { getDisplayNumber } from '../../footnotes/FootnoteNumberingService.js';
import { canUserEditBook } from '../../utilities/auth.js';

/**
 * Build footnote content section
 * @param {Object} contentType - The footnote content type object
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<string>} HTML string for footnote content
 */
export async function buildFootnoteContent(contentType, db = null) {
  console.time('buildFootnoteContent-total');
  try {
    const { fnCountId, footnoteId } = contentType;

    // footnoteId is already extracted by detection.js
    if (!footnoteId) {
      console.error('No footnoteId found in contentType:', contentType);
      return '';
    }

    // Check if user can edit this book's footnotes
    console.time('canUserEditBook');
    const isEditable = await canUserEditBook(book);
    console.timeEnd('canUserEditBook');

    const database = db || await openDatabase();
    const transaction = database.transaction(["footnotes"], "readonly");
    const store = transaction.objectStore("footnotes");

    const key = [book, footnoteId];
    const result = await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // Use dynamic display number from FootnoteNumberingService, fallback to fnCountId
    const displayNumber = getDisplayNumber(footnoteId) || fnCountId || '?';

    if (result) {
      // Remove or replace block-level tags to keep content inline
      const inlineContent = (result.content || '')
        .replace(/<\/?p[^>]*>/g, '') // Remove <p> tags
        .replace(/<\/?div[^>]*>/g, '') // Remove <div> tags
        .replace(/<a[^>]*id="[^"]*Fn[^"]*"[^>]*><\/a>/gi, ''); // Remove anchor tags (footnote jump targets)

      const isEmpty = !result.content || !result.content.trim();
      const emptyClass = isEmpty ? 'empty-footnote' : '';

      console.timeEnd('buildFootnoteContent-total');
      return `
        <div class="footnotes-section" data-content-id="${footnoteId}" data-footnote-id="${footnoteId}">
          <div class="footnote-content">
            <div class="footnote-header" style="display: flex; align-items: flex-start;">
              <sup class="footnote-number" style="margin-right: 1em; flex-shrink: 0; font-weight: bold;">${displayNumber}</sup>
              <span class="footnote-text ${emptyClass}" contenteditable="${isEditable}" data-footnote-id="${footnoteId}" tabindex="0" style="flex: 1; outline: none;">${inlineContent}</span>
            </div>
          </div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    } else {
      // New footnote with no content yet (or not found)
      console.timeEnd('buildFootnoteContent-total');
      return `
        <div class="footnotes-section" data-content-id="${footnoteId}" data-footnote-id="${footnoteId}">
          <div class="footnote-content">
            <div class="footnote-header" style="display: flex; align-items: flex-start;">
              <sup class="footnote-number" style="margin-right: 1em; flex-shrink: 0; font-weight: bold;">${displayNumber}</sup>
              <span class="footnote-text empty-footnote" contenteditable="${isEditable}" data-footnote-id="${footnoteId}" tabindex="0" style="flex: 1; outline: none;"></span>
            </div>
          </div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    }
  } catch (error) {
    console.timeEnd('buildFootnoteContent-total');
    console.error('Error building footnote content:', error);
    const footnoteId = contentType.elementId || 'unknown';
    const fnCountId = contentType.fnCountId || '?';
    // Use dynamic display number for error case too
    const displayNumber = getDisplayNumber(footnoteId) || fnCountId;
    return `
      <div class="footnotes-section" data-content-id="${footnoteId}">
        <sup>${displayNumber}</sup>
        <div class="error">Error loading footnote</div>
        <hr>
      </div>`;
  }
}
