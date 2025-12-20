/**
 * FootnoteNumberingService
 *
 * Manages dynamic footnote numbering based on document position (startLine).
 * Stores footnote IDs in nodes.footnotes, calculates display numbers on demand.
 *
 * This solves the problem of renumbering footnotes when inserting/deleting -
 * instead of storing display numbers (1, 2, 3), we store unique IDs and
 * calculate display numbers dynamically based on document order.
 */

import { log, verbose } from '../utilities/logger.js';

// Module-level cache
let footnoteMap = new Map(); // footnoteId → displayNumber
let reverseMap = new Map();  // displayNumber → footnoteId
let currentBookId = null;

/**
 * Build the footnote numbering map for a book.
 * Sorts nodes by startLine and assigns sequential numbers to footnote IDs.
 *
 * @param {string} bookId - Book identifier
 * @param {Array} nodes - All nodes for the book (from IndexedDB)
 * @returns {Map} footnoteId → displayNumber
 */
export function buildFootnoteMap(bookId, nodes) {
  // Clear existing cache if book changed
  if (currentBookId !== bookId) {
    footnoteMap.clear();
    reverseMap.clear();
    currentBookId = bookId;
  }

  if (!nodes || nodes.length === 0) {
    verbose.content('No nodes provided to buildFootnoteMap', 'FootnoteNumberingService.js');
    return footnoteMap;
  }

  // Sort nodes by startLine to get document order
  const sortedNodes = [...nodes].sort((a, b) => {
    const aLine = parseFloat(a.startLine) || 0;
    const bLine = parseFloat(b.startLine) || 0;
    return aLine - bLine;
  });

  // Collect all footnote IDs in document order
  const orderedFootnoteIds = [];
  const seenIds = new Set();

  // ALWAYS extract from HTML content to get current state
  // The nodes.footnotes arrays may be stale after edits
  // HTML content is the source of truth for what footnotes exist
  extractFootnoteIdsFromContent(sortedNodes, orderedFootnoteIds, seenIds);

  // Build the maps
  footnoteMap.clear();
  reverseMap.clear();

  orderedFootnoteIds.forEach((footnoteId, index) => {
    const displayNumber = index + 1;
    footnoteMap.set(footnoteId, displayNumber);
    reverseMap.set(displayNumber, footnoteId);
  });

  if (footnoteMap.size > 0) {
    verbose.content(`Built footnote map with ${footnoteMap.size} entries for book ${bookId}`, 'FootnoteNumberingService.js');
  }

  return footnoteMap;
}

/**
 * Check if a value is a footnote ID (new format) vs display number (old format)
 * @param {string} value
 * @returns {boolean}
 */
function isFootnoteId(value) {
  if (!value || typeof value !== 'string') return false;
  // New format contains "_Fn" (e.g., "bookId_Fn1758412345001")
  // Old format is just a number (e.g., "1", "2")
  return value.includes('_Fn') || value.includes('Fn');
}

/**
 * Extract footnote IDs from HTML content when nodes.footnotes has old format
 * @param {Array} nodes - Sorted nodes array
 * @param {Array} orderedFootnoteIds - Array to populate
 * @param {Set} seenIds - Set to track duplicates
 */
function extractFootnoteIdsFromContent(nodes, orderedFootnoteIds, seenIds) {
  for (const node of nodes) {
    if (!node.content) continue;

    // Create a temporary element to parse HTML
    const temp = document.createElement('div');
    temp.innerHTML = node.content;

    // Find all footnote links - support both old and new formats:
    // Old format: <sup fn-count-id="2"><a href="#bookIdFn...">2</a></sup> (no .footnote-ref class)
    // New format: <sup fn-count-id="2"><a class="footnote-ref" href="#bookId_Fn...">2</a></sup>
    const footnoteLinks = temp.querySelectorAll('sup[fn-count-id] a, sup a.footnote-ref, a.footnote-ref');

    for (const link of footnoteLinks) {
      const href = link.getAttribute('href');
      if (!href) continue;

      // Extract footnote ID from href (e.g., "#bookId_Fn1758412345001" → "bookId_Fn1758412345001")
      const footnoteId = href.replace(/^#/, '');

      if (footnoteId && !seenIds.has(footnoteId) && isFootnoteId(footnoteId)) {
        orderedFootnoteIds.push(footnoteId);
        seenIds.add(footnoteId);
      }
    }
  }
}

/**
 * Get display number for a footnote ID
 * @param {string} footnoteId
 * @returns {number|null}
 */
export function getDisplayNumber(footnoteId) {
  if (!footnoteId) return null;
  return footnoteMap.get(footnoteId) || null;
}

/**
 * Get footnote ID for a display number
 * @param {number} displayNumber
 * @returns {string|null}
 */
export function getFootnoteId(displayNumber) {
  return reverseMap.get(displayNumber) || null;
}

/**
 * Get current book ID for the cached map
 * @returns {string|null}
 */
export function getCurrentBookId() {
  return currentBookId;
}

/**
 * Rebuild map and trigger DOM update.
 * Called when footnotes are added/deleted.
 *
 * @param {string} bookId
 * @param {Array} nodes
 */
export async function rebuildAndRenumber(bookId, nodes) {
  verbose.content(`Rebuilding footnote map for book ${bookId}`, 'FootnoteNumberingService.js');

  buildFootnoteMap(bookId, nodes);
  updateFootnoteNumbersInDOM();

  // Emit event for any listeners
  window.dispatchEvent(new CustomEvent('footnotesRenumbered', {
    detail: { bookId, count: footnoteMap.size }
  }));

  verbose.content(`Footnotes renumbered: ${footnoteMap.size} total`, 'FootnoteNumberingService.js');
}

/**
 * Update all visible footnote numbers in the DOM.
 * Called after rebuildAndRenumber or when chunks are loaded.
 */
export function updateFootnoteNumbersInDOM() {
  // Find all footnote reference sups in the DOM - support both old and new formats
  // Old format: <sup fn-count-id="2"><a href="#bookIdFn...">2</a></sup> (no .footnote-ref class)
  // New format: <sup fn-count-id="2"><a class="footnote-ref" href="#bookId_Fn...">2</a></sup>
  const footnoteRefs = document.querySelectorAll('sup[fn-count-id] a, sup a.footnote-ref');

  for (const link of footnoteRefs) {
    const href = link.getAttribute('href');
    if (!href) continue;

    // Extract footnoteId from href like "#bookId_Fn1758412345001"
    const footnoteId = href.replace(/^#/, '');
    if (!footnoteId) continue;

    // Get the new display number
    const displayNumber = getDisplayNumber(footnoteId);
    if (displayNumber) {
      // Update the parent sup's fn-count-id attribute
      const sup = link.closest('sup');
      if (sup) {
        sup.setAttribute('fn-count-id', displayNumber.toString());
      }
      // Update the visible text
      link.textContent = displayNumber.toString();
    }
  }

  // Also update footnote definition anchors if visible
  const footnoteDefinitions = document.querySelectorAll('a[id][fn-count-id]');
  for (const anchor of footnoteDefinitions) {
    const footnoteId = anchor.id;
    if (!footnoteId || !isFootnoteId(footnoteId)) continue;

    const displayNumber = getDisplayNumber(footnoteId);
    if (displayNumber) {
      anchor.setAttribute('fn-count-id', displayNumber.toString());
    }
  }
}

/**
 * Check if nodes contain old-format footnotes (display numbers instead of IDs)
 * @param {Array} nodes
 * @returns {boolean}
 */
export function hasOldFormatFootnotes(nodes) {
  for (const node of nodes) {
    if (node.footnotes && node.footnotes.length > 0) {
      const firstFootnote = node.footnotes[0];
      // Old format: simple numbers like "1", "2"
      // New format: IDs like "bookId_Fn1758412345001"
      if (firstFootnote && !isFootnoteId(firstFootnote)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get current map (for debugging/testing)
 * @returns {Map}
 */
export function getCurrentMap() {
  return new Map(footnoteMap);
}

/**
 * Get map size
 * @returns {number}
 */
export function getMapSize() {
  return footnoteMap.size;
}

/**
 * Migrate old-format footnotes (display numbers) to new format (footnote IDs).
 * This updates nodes.footnotes arrays to use IDs instead of numbers.
 *
 * @param {string} bookId - Book identifier
 * @param {Array} nodes - All nodes for the book
 * @returns {Promise<Array>} - Updated nodes array (also modifies in place)
 */
export async function migrateOldFormatFootnotes(bookId, nodes) {
  if (!hasOldFormatFootnotes(nodes)) {
    verbose.content('Nodes already in new format, no migration needed', 'FootnoteNumberingService.js');
    return nodes;
  }

  log.content(`Migrating old footnote format to new format for book ${bookId}...`, 'FootnoteNumberingService.js');

  // Build a map from display number to footnote ID by scanning HTML content
  const displayToId = new Map();

  for (const node of nodes) {
    if (!node.content) continue;

    const temp = document.createElement('div');
    temp.innerHTML = node.content;

    // Find all footnote reference links - check both old format (just <a>) and new format (a.footnote-ref)
    // Old format: <sup fn-count-id="2"><a href="#bookIdFn...">2</a></sup>
    // New format: <sup fn-count-id="2"><a class="footnote-ref" href="#bookId_Fn...">2</a></sup>
    const footnoteLinks = temp.querySelectorAll('sup[fn-count-id] a');
    for (const link of footnoteLinks) {
      const sup = link.closest('sup');
      const displayNum = sup?.getAttribute('fn-count-id');
      const href = link.getAttribute('href');
      const footnoteId = href?.replace(/^#/, '');

      if (displayNum && footnoteId && isFootnoteId(footnoteId)) {
        displayToId.set(displayNum, footnoteId);
      }
    }
  }

  // Update each node's footnotes array
  let migratedCount = 0;
  for (const node of nodes) {
    if (node.footnotes && node.footnotes.length > 0) {
      const oldFootnotes = [...node.footnotes];
      node.footnotes = node.footnotes.map(displayNum => {
        const footnoteId = displayToId.get(displayNum);
        if (footnoteId) {
          migratedCount++;
          return footnoteId;
        }
        return displayNum; // Keep original if no mapping found
      });
    }
  }

  log.content(`Migration complete: ${migratedCount} footnote references migrated`, 'FootnoteNumberingService.js');

  // Note: The caller should save the updated nodes to IndexedDB if needed
  return nodes;
}

/**
 * Clear cache (for book switching or cleanup)
 */
export function clearCache() {
  footnoteMap.clear();
  reverseMap.clear();
  currentBookId = null;
  verbose.content('Footnote cache cleared', 'FootnoteNumberingService.js');
}
