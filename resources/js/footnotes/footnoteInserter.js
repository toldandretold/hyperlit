/**
 * Footnote Inserter Module
 * Handles insertion of new footnotes at cursor position
 */

import { openDatabase, getNodeChunksFromIndexedDB, queueForSync } from '../indexedDB/index.js';
import { rebuildAndRenumber, getDisplayNumber } from './FootnoteNumberingService.js';
import { handleUnifiedContentClick } from '../hyperlitContainer/index.js';

/**
 * Generate a unique footnote ID
 * Format: Fn{timestamp}_{random} (shorter, without book prefix)
 * @param {string} bookId - Not used, kept for API compatibility
 * @returns {string}
 */
export function generateFootnoteId(bookId) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 6);
  return `Fn${timestamp}_${random}`;
}

/**
 * Insert a footnote at the current cursor position
 * @param {Range} range - The current selection range
 * @param {string} bookId - Current book ID
 * @param {Function} saveCallback - Callback to save node to IndexedDB
 * @returns {Promise<{footnoteId: string, supElement: HTMLElement}>}
 */
export async function insertFootnoteAtCursor(range, bookId, saveCallback) {
  if (!range) {
    throw new Error('No valid cursor position');
  }

  // 1. Generate unique footnote ID
  const footnoteId = generateFootnoteId(bookId);

  // 2. Create the sup element with placeholder display number "?"
  // New format: <sup fn-count-id="1" id="footnoteId" class="footnote-ref">1</sup>
  const supElement = document.createElement('sup');
  supElement.setAttribute('fn-count-id', '?');
  supElement.id = footnoteId;
  supElement.className = 'footnote-ref';
  supElement.textContent = '?';

  // Save scroll position before DOM manipulation
  // Check multiple possible scrollable containers
  const scrollContainer = document.querySelector('.reader-content-wrapper')
    || document.querySelector('.main-content')
    || document.querySelector('main');
  const savedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

  // 3. Insert at cursor position
  range.insertNode(supElement);

  // 4. Move cursor after the inserted footnote
  range.setStartAfter(supElement);
  range.collapse(true);

  // Restore selection without scrolling
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  // Restore scroll position (browser may have scrolled during insertion)
  if (scrollContainer) {
    scrollContainer.scrollTop = savedScrollTop;
  }

  // 5. Find the parent node element to save
  // Nodes have IDs like "1_2" where first part is startLine
  const parentNode = supElement.closest('[id]');

  if (parentNode && parentNode.id && saveCallback) {
    console.log(`Saving parent node: ${parentNode.id}`);
    await saveCallback(parentNode.id, parentNode.outerHTML);
  }

  // 6. Create footnote record in IndexedDB (don't await PostgreSQL sync)
  await createFootnoteRecord(footnoteId, bookId);

  // 7. Rebuild and renumber all footnotes (non-blocking)
  // Do this in the background so the UI stays responsive
  getNodeChunksFromIndexedDB(bookId).then(allNodes => {
    rebuildAndRenumber(bookId, allNodes).then(() => {
      // 8. Update the display number in the DOM after renumbering completes
      const displayNumber = getDisplayNumber(footnoteId);
      if (displayNumber) {
        supElement.setAttribute('fn-count-id', displayNumber.toString());
        supElement.textContent = displayNumber.toString();
        console.log(`Footnote ${footnoteId} assigned display number: ${displayNumber}`);
      }
    });
  });

  return { footnoteId, supElement };
}

/**
 * Create a new footnote record in IndexedDB
 * @param {string} footnoteId
 * @param {string} bookId
 */
async function createFootnoteRecord(footnoteId, bookId) {
  const db = await openDatabase();
  const tx = db.transaction('footnotes', 'readwrite');
  const store = tx.objectStore('footnotes');

  const now = new Date().toISOString();
  const footnoteRecord = {
    book: bookId,
    footnoteId: footnoteId,
    content: '', // Empty - placeholder handled in UI
    created_at: now,
    updated_at: now
  };

  await new Promise((resolve, reject) => {
    const request = store.put(footnoteRecord);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      console.log(`Created footnote record: ${footnoteId}`);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });

  // Queue for sync via unified sync mechanism (handles offline mode)
  queueForSync("footnotes", footnoteId, "update", footnoteRecord);
}

/**
 * Open the hyperlit container with the newly created footnote
 * @param {string} footnoteId
 * @param {HTMLElement} supElement
 */
export async function openFootnoteForEditing(footnoteId, supElement) {
  // Use handleUnifiedContentClick with the sup element
  // This will detect it as a footnote and build the content
  // Pass isNewFootnote=true so the container knows to auto-focus
  await handleUnifiedContentClick(supElement, null, [], false, false, null, true);
}
