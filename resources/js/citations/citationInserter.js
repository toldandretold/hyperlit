/**
 * Citation Inserter Module
 * Handles insertion of author-date citations at cursor position
 */

import { openDatabase, queueForSync } from '../indexedDB/index.js';
import { formatBibtexToCitation } from '../utilities/bibtexProcessor.js';

/**
 * Generate a unique reference ID
 * Format: Ref{timestamp}_{random}
 * @returns {string}
 */
export function generateReferenceId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 6);
  return `Ref${timestamp}_${random}`;
}

/**
 * Parse bibtex to extract author and year for inline citation
 * @param {string} bibtex - The BibTeX string
 * @returns {{author: string, year: string}}
 */
export function parseAuthorYear(bibtex) {
  const fields = {};
  const fieldRegex = /(\w+)\s*=\s*[{"]([^"}]+)[}"]/g;
  let match;
  while ((match = fieldRegex.exec(bibtex)) !== null) {
    fields[match[1].toLowerCase()] = match[2];
  }

  // Extract author - take first author's surname for "et al." format
  let author = 'Unknown';
  if (fields.author) {
    const rawAuthor = fields.author;
    // Handle "Last, First" or "First Last" format
    // Also handle multiple authors separated by "and"
    const authors = rawAuthor.split(/\s+and\s+/i);

    if (authors.length === 1) {
      // Single author - extract surname
      const parts = authors[0].split(',');
      if (parts.length > 1) {
        // "Last, First" format
        author = parts[0].trim();
      } else {
        // "First Last" format - take last word
        const words = authors[0].trim().split(/\s+/);
        author = words[words.length - 1];
      }
    } else if (authors.length === 2) {
      // Two authors: "Author1 & Author2"
      const getLastName = (name) => {
        const parts = name.split(',');
        if (parts.length > 1) return parts[0].trim();
        const words = name.trim().split(/\s+/);
        return words[words.length - 1];
      };
      author = `${getLastName(authors[0])} & ${getLastName(authors[1])}`;
    } else {
      // Three or more: "Author1 et al."
      const parts = authors[0].split(',');
      if (parts.length > 1) {
        author = parts[0].trim() + ' et al.';
      } else {
        const words = authors[0].trim().split(/\s+/);
        author = words[words.length - 1] + ' et al.';
      }
    }
  }

  // Extract year
  const year = fields.year || 'n.d.';

  return { author, year };
}

/**
 * Insert a citation at the current cursor position
 * @param {Range} range - The current selection range
 * @param {string} currentBookId - The book where citation is being inserted
 * @param {string} citedBookId - The book being cited
 * @param {string} bibtex - The bibtex of the cited book
 * @param {Function} saveCallback - Callback to save node to IndexedDB
 * @returns {Promise<{referenceId: string, anchorElement: HTMLElement}>}
 */
export async function insertCitationAtCursor(range, currentBookId, citedBookId, bibtex, saveCallback) {
  if (!range) {
    throw new Error('No valid cursor position');
  }

  // 1. Generate unique reference ID
  const referenceId = generateReferenceId();

  // 2. Parse bibtex to get author and year
  const { author, year } = parseAuthorYear(bibtex);

  // 3. Create the citation elements
  // Format: (Author <a id="RefXXX" class="citation-ref">Year</a>)
  // No href - click handling opens hyperlit-container via detection system
  const citationWrapper = document.createDocumentFragment();

  // Opening paren and author
  const openText = document.createTextNode(`(${author} `);
  citationWrapper.appendChild(openText);

  // Year as anchor link (no href - hyperlit container handles click)
  const anchorElement = document.createElement('a');
  anchorElement.id = referenceId;
  anchorElement.className = 'citation-ref';
  anchorElement.textContent = year;
  citationWrapper.appendChild(anchorElement);

  // Closing paren
  const closeText = document.createTextNode(')');
  citationWrapper.appendChild(closeText);

  // Save scroll position before DOM manipulation
  const scrollContainer = document.querySelector('.reader-content-wrapper')
    || document.querySelector('.main-content')
    || document.querySelector('main');
  const savedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

  // 4. Insert at cursor position
  range.insertNode(citationWrapper);

  // 5. Move cursor after the inserted citation
  range.setStartAfter(closeText);
  range.collapse(true);

  // Restore selection without scrolling
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  // Restore scroll position
  if (scrollContainer) {
    scrollContainer.scrollTop = savedScrollTop;
  }

  // 6. Find the parent node element to save
  let parentNode = anchorElement.parentElement;
  while (parentNode && !/^\d+(\.\d+)?$/.test(parentNode.id || '')) {
    parentNode = parentNode.parentElement;
  }

  if (parentNode && parentNode.id && saveCallback) {
    console.log(`Saving parent node: ${parentNode.id}`);
    await saveCallback(parentNode.id, parentNode.outerHTML);
  }

  // 7. Create bibliography record in IndexedDB
  const formattedCitation = await formatBibtexToCitation(bibtex);
  await createBibliographyRecord(referenceId, currentBookId, citedBookId, formattedCitation);

  console.log(`✅ Citation inserted: ${referenceId} citing ${citedBookId}`);

  return { referenceId, anchorElement };
}

/**
 * Create a new bibliography record in IndexedDB
 * @param {string} referenceId - Unique reference ID
 * @param {string} bookId - The book containing the citation
 * @param {string} sourceId - The book being cited (pointer)
 * @param {string} content - Formatted citation text
 */
async function createBibliographyRecord(referenceId, bookId, sourceId, content) {
  const db = await openDatabase();
  const tx = db.transaction('bibliography', 'readwrite');
  const store = tx.objectStore('bibliography');

  const now = new Date().toISOString();
  const bibliographyRecord = {
    book: bookId,
    referenceId: referenceId,
    source_id: sourceId,
    content: content,
    created_at: now,
    updated_at: now
  };

  await new Promise((resolve, reject) => {
    const request = store.put(bibliographyRecord);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      console.log(`Created bibliography record: ${referenceId}`);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });

  // Queue for sync via unified sync mechanism
  queueForSync("bibliography", referenceId, "update", bibliographyRecord);
}
