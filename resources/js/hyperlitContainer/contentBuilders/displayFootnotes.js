/**
 * Footnote Content Builder
 * Constructs HTML content for displaying footnotes in the hyperlit container
 */

import { book } from '../../app.js';
import { openDatabase } from '../../indexedDB/index.js';

/**
 * Build footnote content section
 * @param {Object} contentType - The footnote content type object
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<string>} HTML string for footnote content
 */
export async function buildFootnoteContent(contentType, db = null) {
  try {
    const { elementId, fnCountId, element } = contentType;

    // Get the actual footnoteId from the link's href, not the elementId
    let footnoteId = null;

    // Look for the footnote link inside the sup element
    const footnoteLink = element.querySelector('a.footnote-ref');
    if (footnoteLink && footnoteLink.href) {
      // Extract footnoteId from href like "#test555gdzzdddcsxkkFn1758412345001"
      footnoteId = footnoteLink.href.split('#')[1];
      console.log(`🔍 Found footnote link with href: ${footnoteLink.href}, extracted footnoteId: ${footnoteId}`);
    }

    // Fallback: try the old method if no link found
    if (!footnoteId) {
      footnoteId = elementId;
      if (footnoteId && footnoteId.includes('ref')) {
        footnoteId = footnoteId.replace('ref', '');
      }
    }

    const database = db || await openDatabase();
    const transaction = database.transaction(["footnotes"], "readonly");
    const store = transaction.objectStore("footnotes");

    const key = [book, footnoteId];
    const result = await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (result && result.content) {
      // Remove or replace block-level tags to keep content inline
      const inlineContent = result.content
        .replace(/<\/?p[^>]*>/g, '') // Remove <p> tags
        .replace(/<\/?div[^>]*>/g, ''); // Remove <div> tags

      return `
        <div class="footnotes-section" data-content-id="${footnoteId}">
          <div class="footnote-content">
            <div class="footnote-text" style="display: flex; align-items: flex-start;"><sup style="margin-right: 1em; flex-shrink: 0;">${fnCountId}</sup><span style="flex: 1;">${inlineContent}</span></div>
          </div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    } else {
      return `
        <div class="footnotes-section" data-content-id="${footnoteId}">
          <sup>${fnCountId}</sup>
          <div class="error">Footnote not found: ${footnoteId}</div>
          <hr>
        </div>`;
    }
  } catch (error) {
    console.error('Error building footnote content:', error);
    const footnoteId = contentType.elementId || 'unknown';
    const fnCountId = contentType.fnCountId || '?';
    return `
      <div class="footnotes-section" data-content-id="${footnoteId}">
        <sup>${fnCountId}</sup>
        <div class="error">Error loading footnote</div>
        <hr>
      </div>`;
  }
}
