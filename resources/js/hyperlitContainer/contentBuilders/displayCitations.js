/**
 * Citation Content Builder
 * Constructs HTML content for displaying citations and hypercite citations in the hyperlit container
 */

import { book } from '../../app.js';
import { openDatabase } from '../../indexedDB.js';
import { formatBibtexToCitation } from '../../bibtexProcessor.js';

/**
 * Build citation content section
 * @param {Object} contentType - The citation content type object
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<string>} HTML string for citation content
 */
export async function buildCitationContent(contentType, db = null) {
  try {
    const { referenceId } = contentType;

    const database = db || await openDatabase();
    const transaction = database.transaction(["references"], "readonly");
    const store = transaction.objectStore("references");

    const key = [book, referenceId];
    const result = await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (result && result.content) {
      return `
        <div class="citations-section" data-content-id="${referenceId}">
          <div class="citation-content">
            <div class="citation-text">${result.content}</div>
          </div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    } else {
      return `
        <div class="citations-section" data-content-id="${referenceId}">
          <div class="error">Reference not found: ${referenceId}</div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    }
  } catch (error) {
    console.error('Error building citation content:', error);
    return `
      <div class="citations-section" data-content-id="error">
        <h3>Citation:</h3>
        <div class="error">Error loading reference</div>
        <hr>
      </div>`;
  }
}

/**
 * Build hypercite citation content section (for links pointing TO hypercites)
 * @param {Object} contentType - The hypercite citation content type object
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<string>} HTML string for hypercite citation content
 */
export async function buildHyperciteCitationContent(contentType, db = null) {
  try {
    const { targetBook, targetHyperciteId, targetUrl } = contentType;

    console.log(`🔗 Building hypercite citation for: ${targetBook}#${targetHyperciteId}`);

    const database = db || await openDatabase();
    const transaction = database.transaction(['library'], 'readonly');
    const store = transaction.objectStore('library');

    const result = await new Promise((resolve, reject) => {
      const request = store.get(targetBook);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    let libraryData = result;
    let formattedCitation = '';

    if (result && result.bibtex) {
      formattedCitation = await formatBibtexToCitation(result.bibtex);
    } else {
      // Fallback: try to fetch from server - import fetchLibraryFromServer from utils
      const { fetchLibraryFromServer } = await import('../utils.js');
      const serverLibraryData = await fetchLibraryFromServer(targetBook);
      libraryData = serverLibraryData; // Update libraryData with server result
      if (serverLibraryData && serverLibraryData.bibtex) {
        formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
      } else {
        // Last resort: use book ID
        formattedCitation = targetBook;
      }
    }

    // Check if book is private and if user has access
    const isPrivate = libraryData && libraryData.visibility === 'private';
    let hasAccess = true;

    if (isPrivate) {
      console.log(`🔒 Target book ${targetBook} is private, checking access...`);
      const { canUserEditBook } = await import('../../auth.js');
      hasAccess = await canUserEditBook(targetBook);
      console.log(`🔒 Access result: ${hasAccess ? 'ALLOWED' : 'DENIED'}`);
    }

    // Add lock icon if private (no negative margin here - single citation, no list alignment needed)
    const lockIcon = isPrivate
      ? '<svg class="private-lock-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d73a49" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 4px; transition: transform 0.2s ease;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'
      : '';

    // Configure button based on access
    const buttonText = (isPrivate && !hasAccess) ? 'source text private' : 'See in source text';
    const buttonStyle = (isPrivate && !hasAccess)
      ? 'display: inline-block; padding: 0.5em 1em; background: #4EACAE; color: #221F20; text-decoration: none; border-radius: 4px; opacity: 0.6; cursor: not-allowed;'
      : 'display: inline-block; padding: 0.5em 1em; background: #4EACAE; color: #221F20; text-decoration: none; border-radius: 4px;';
    const buttonAttrs = (isPrivate && !hasAccess)
      ? `data-private="true" data-access="denied" data-book-id="${targetBook}"`
      : '';

    return `
      <div class="hypercite-citation-section" data-content-id="${targetHyperciteId}">
        <h3>Reference</h3>
        <div class="citation-text">
          ${lockIcon}${formattedCitation}
        </div>
        <div style="margin-top: 1em;">
          <a href="${targetUrl}" class="see-in-source-btn" ${buttonAttrs} style="${buttonStyle}">
            ${buttonText}
          </a>
        </div>
        <hr style="margin: 2em 0; opacity: 0.5;">
      </div>`;
  } catch (error) {
    console.error('Error building hypercite citation content:', error);
    return `
      <div class="hypercite-citation-section">
        <h3>Reference</h3>
        <div class="error">Error loading citation</div>
        <hr style="margin: 2em 0; opacity: 0.5;">
      </div>`;
  }
}
