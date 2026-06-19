import { asBookId } from "../indexedDB/types";
/**
 * Citation Inserter Module
 * Handles insertion of author-date citations at cursor position.
 *
 * Test coverage:
 *   - tests/javascript/citations/citationInserter.test.js (Vitest)
 *       parseAuthorYear edge cases, generateReferenceId format,
 *       insertCitationAtCursor with both new picked-object shape AND legacy
 *       positional signature, asserts bibliography record includes both
 *       source_id and canonical_source_id pointers.
 * See tests/Feature/Citations/README.md for the full suite.
 */

import { openDatabase, queueForSync } from '../indexedDB/index';
import type { BibliographyRecord } from '../indexedDB/types';
import { formatBibtexToCitation } from '../utilities/bibtexProcessor';

/**
 * Generate a unique reference ID
 * Format: Ref{timestamp}_{random}
 */
export function generateReferenceId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 6);
  return `Ref${timestamp}_${random}`;
}

/**
 * Parse bibtex to extract author and year for inline citation
 */
export function parseAuthorYear(bibtex: string): { author: string; year: string } {
  const fields: Record<string, string> = {};
  const fieldRegex = /(\w+)\s*=\s*[{"]([^"}]+)[}"]/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(bibtex)) !== null) {
    fields[match[1]!.toLowerCase()] = match[2]!;
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
      const parts = authors[0]!.split(',');
      if (parts.length > 1) {
        // "Last, First" format
        author = parts[0]!.trim();
      } else {
        // "First Last" format - take last word
        const words = authors[0]!.trim().split(/\s+/);
        author = words[words.length - 1]!;
      }
    } else if (authors.length === 2) {
      // Two authors: "Author1 & Author2"
      const getLastName = (name: string): string => {
        const parts = name.split(',');
        if (parts.length > 1) return parts[0]!.trim();
        const words = name.trim().split(/\s+/);
        return words[words.length - 1]!;
      };
      author = `${getLastName(authors[0]!)} & ${getLastName(authors[1]!)}`;
    } else {
      // Three or more: "Author1 et al."
      const parts = authors[0]!.split(',');
      if (parts.length > 1) {
        author = parts[0]!.trim() + ' et al.';
      } else {
        const words = authors[0]!.trim().split(/\s+/);
        author = words[words.length - 1]! + ' et al.';
      }
    }
  }

  // Extract year
  const year = fields.year || 'n.d.';

  return { author, year };
}

/**
 * Insert a citation at the current cursor position.
 *
 * Accepts either the legacy positional signature (kept for backward compat with
 * any older callers) or the new richer `picked` object that the citation modal
 * now produces post-PR4/5.
 *
 * New shape (preferred):
 *   insertCitationAtCursor(range, currentBookId, {
 *     book,                  // library.book of the chosen version, or '' for canonical-only
 *     canonical_source_id,   // canonical.id when known
 *     bibtex,                // real (library) or synthetic (canonical)
 *     has_nodes,             // whether the citation has a text version available
 *   }, saveCallback)
 *
 * Legacy shape (still works):
 *   insertCitationAtCursor(range, currentBookId, citedBookId, bibtex, saveCallback, sourceHasNodes)
 *
 * @returns {Promise<{referenceId: string, anchorElement: HTMLElement}>}
 */
interface PickedCitation {
  book?: string;
  canonical_source_id?: string | null;
  bibtex?: string;
  has_nodes?: boolean;
}

type SaveCallback = (id: string, html: string) => Promise<void> | void;

export async function insertCitationAtCursor(
  range: any,
  currentBookId: string,
  pickedOrCitedBookId: PickedCitation | string,
  bibtexOrSaveCallback: SaveCallback | string,
  saveCallbackOrSourceHasNodes?: SaveCallback,
  legacySourceHasNodes = true,
): Promise<{ referenceId: string; anchorElement: HTMLAnchorElement }> {
  if (!range) {
    throw new Error('No valid cursor position');
  }

  // Normalise to a single `picked` object.
  let picked: PickedCitation;
  let saveCallback: SaveCallback | undefined;
  if (pickedOrCitedBookId && typeof pickedOrCitedBookId === 'object') {
    picked = pickedOrCitedBookId;
    saveCallback = bibtexOrSaveCallback as SaveCallback;
  } else {
    picked = {
      book: pickedOrCitedBookId as string,
      canonical_source_id: null,
      bibtex: bibtexOrSaveCallback as string,
      has_nodes: legacySourceHasNodes,
    };
    saveCallback = saveCallbackOrSourceHasNodes;
  }

  const citedBookId = picked.book || '';
  const canonicalSourceId = picked.canonical_source_id || null;
  const bibtex = picked.bibtex || '';
  const sourceHasNodes = picked.has_nodes !== false;

  // Citation must reference at least one identity — either a library version we
  // can navigate to OR a canonical record for the citation-card flow.
  if (!citedBookId && !canonicalSourceId) {
    throw new Error('Citation insert requires either book or canonical_source_id');
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
  selection?.removeAllRanges();
  selection?.addRange(range);

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
  await createBibliographyRecord(referenceId, currentBookId, citedBookId, formattedCitation, sourceHasNodes, canonicalSourceId);

  console.log(`✅ Citation inserted: ${referenceId} citing ${citedBookId || canonicalSourceId} (canonical=${canonicalSourceId ?? '-'})`);

  return { referenceId, anchorElement };
}

/**
 * Create a new bibliography record in IndexedDB.
 *
 * Stores both pointers when available:
 *   - source_id          = library.book of the chosen version (legacy + canonical-with-version)
 *   - canonical_source_id = canonical.id (canonical + canonical-only)
 *
 * The resolver in `resources/js/indexedDB/bibliography/index.js` consumes
 * canonical_source_id first; falls back to source_id for old records and
 * orphan-library citations.
 *
 * @param {string} referenceId - Unique reference ID
 * @param {string} bookId - The book containing the citation
 * @param {string} sourceId - The library.book of the cited version (may be '')
 * @param {string} content - Formatted citation text
 * @param {boolean} sourceHasNodes - Whether the citation has navigable text
 * @param {string|null} canonicalSourceId - canonical.id when known
 */
async function createBibliographyRecord(
  referenceId: string,
  bookId: string,
  sourceId: string,
  content: string,
  sourceHasNodes = true,
  canonicalSourceId: string | null = null,
): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('bibliography', 'readwrite');
  const store = tx.objectStore('bibliography');

  const now = new Date().toISOString();
  const bibliographyRecord: BibliographyRecord = {
    book: asBookId(bookId),
    referenceId: referenceId,
    source_id: sourceId,
    canonical_source_id: canonicalSourceId,
    content: content,
    source_has_nodes: sourceHasNodes,
    created_at: now,
    updated_at: now
  };

  await new Promise<void>((resolve, reject) => {
    const request = store.put(bibliographyRecord);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      console.log(`Created bibliography record: ${referenceId}`);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });

  // Queue for sync via unified sync mechanism
  queueForSync("bibliography", referenceId, "update", bibliographyRecord);
}
