/**
 * Citation Content Builder
 * Constructs HTML content for displaying citations and hypercite citations in the hyperlit container
 */

import { book } from '../../app.js';
import { openDatabase } from '../../indexedDB/index.js';
import { formatBibtexToCitation } from "../../utilities/bibtexProcessor.js";

/**
 * Build citation content section
 * Supports both unlinked citations (just content) and linked citations (source_id with navigation)
 * @param {Object} contentType - The citation content type object
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<string>} HTML string for citation content
 */
export async function buildCitationContent(contentType, db = null) {
  try {
    const { referenceId } = contentType;

    if (!referenceId) {
      console.error('No referenceId found in contentType:', contentType);
      return '';
    }

    const database = db || await openDatabase();
    const transaction = database.transaction(["bibliography", "library"], "readonly");
    const bibliographyStore = transaction.objectStore("bibliography");

    const key = [book, referenceId];
    const result = await new Promise((resolve, reject) => {
      const request = bibliographyStore.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (result && result.content) {
      // Build navigation link if source_id exists (linked citation)
      let navigationLink = '';
      if (result.source_id) {
        // Fetch the library entry to check visibility
        const libraryStore = transaction.objectStore('library');
        const libraryRecord = await new Promise((resolve) => {
          const request = libraryStore.get(result.source_id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        });

        // Check access for private books
        let hasAccess = true;
        const isPrivate = libraryRecord && libraryRecord.visibility === 'private';
        const isDeleted = libraryRecord && libraryRecord.visibility === 'deleted';

        if (isPrivate) {
          const { canUserEditBook } = await import('../../utilities/auth.js');
          hasAccess = await canUserEditBook(result.source_id);
        }

        // Configure button based on access
        let buttonText = 'Open source';
        let buttonStyle = 'display: inline-flex; align-items: center; gap: 0.5em; padding: 0.5em 1em; background: var(--hyperlit-aqua, #4EACAE); color: var(--hyperlit-black, #221F20); text-decoration: none; border-radius: 4px;';
        let buttonAttrs = '';

        if (isDeleted) {
          buttonText = 'Source deleted';
          buttonStyle += ' opacity: 0.6; cursor: not-allowed;';
          buttonAttrs = `data-deleted="true"`;
        } else if (isPrivate && !hasAccess) {
          buttonText = 'Source private';
          buttonStyle += ' opacity: 0.6; cursor: not-allowed;';
          buttonAttrs = `data-private="true" data-access="denied"`;
        }

        const targetUrl = `/${encodeURIComponent(result.source_id)}`;

        navigationLink = `
          <div class="citation-navigation" style="margin-top: 1em;">
            <a href="${targetUrl}" class="citation-source-link" ${buttonAttrs} style="${buttonStyle}">
              ${buttonText}
              <span class="open-icon">↗</span>
            </a>
          </div>`;
      }

      return `
        <div class="citations-section" data-content-id="${referenceId}" data-reference-id="${referenceId}">
          <h3 style="margin-bottom: 0.5em;">Reference</h3>
          <blockquote style="margin: 0; padding: 0.5em 0; font-style: normal;">
            ${result.content}
          </blockquote>
          ${navigationLink}
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    } else {
      return `
        <div class="citations-section" data-content-id="${referenceId}">
          <h3>Reference</h3>
          <div class="error">Reference not found: ${referenceId}</div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    }
  } catch (error) {
    console.error('Error building citation content:', error);
    const referenceId = contentType?.referenceId || 'unknown';
    return `
      <div class="citations-section" data-content-id="${referenceId}">
        <h3>Reference</h3>
        <div class="error">Error loading reference</div>
        <hr style="margin: 2em 0; opacity: 0.5;">
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

    // Check if book is private, deleted, or accessible
    const isPrivate = libraryData && libraryData.visibility === 'private';
    const isDeleted = libraryData && libraryData.visibility === 'deleted';
    let hasAccess = true;

    if (isPrivate) {
      console.log(`🔒 Target book ${targetBook} is private, checking access...`);
      const { canUserEditBook } = await import('../../utilities/auth.js');
      hasAccess = await canUserEditBook(targetBook);
      console.log(`🔒 Access result: ${hasAccess ? 'ALLOWED' : 'DENIED'}`);
    }

    // Add lock icon if private, trash icon if deleted
    let statusIcon = '';
    if (isDeleted) {
      statusIcon = '<svg class="deleted-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d73a49" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 4px;"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    } else if (isPrivate) {
      statusIcon = '<svg class="private-lock-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d73a49" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 4px; transition: transform 0.2s ease;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
    }

    // Configure button based on access
    let buttonText = 'See in source text';
    let buttonStyle = 'display: inline-block; padding: 0.5em 1em; background: #4EACAE; color: #221F20; text-decoration: none; border-radius: 4px;';
    let buttonAttrs = '';

    if (isDeleted) {
      buttonText = 'source deleted';
      buttonStyle += ' opacity: 0.6; cursor: not-allowed;';
      buttonAttrs = `data-deleted="true" data-book-id="${targetBook}"`;
    } else if (isPrivate && !hasAccess) {
      buttonText = 'source text private';
      buttonStyle += ' opacity: 0.6; cursor: not-allowed;';
      buttonAttrs = `data-private="true" data-access="denied" data-book-id="${targetBook}"`;
    }

    return `
      <div class="hypercite-citation-section" data-content-id="${targetHyperciteId}">
        <h3>Reference</h3>
        <div class="citation-text">
          ${statusIcon}${formattedCitation}
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
