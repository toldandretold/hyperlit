/**
 * footnoteCache — the dynamic-numbering core (leaf; imports only the logger).
 *
 * Owns the module-level footnote maps and the pure map-building logic. Split out
 * of FootnoteNumberingService so the DOM transforms (footnoteDom) and the IDB
 * orchestrator (FootnoteNumberingService) depend on a zero-sibling-import leaf,
 * not on each other.
 */

import { verbose } from '../utilities/logger';

// Module-level cache
let footnoteMap = new Map<string, number | string>(); // footnoteId → displayNumber (or preserved marker)
let reverseMap = new Map<number, string>();  // displayNumber → footnoteId
let currentBookId: string | null = null;

// Test-only diagnostic hook. Off in prod (window.__fnDiag undefined unless an
// e2e test explicitly enables it via `window.__fnDiag = { ... }`).
// Provides:
//   window.__fnDiag.snapshot()   → { bookId, mapEntries, rebuildCount }
//   window.__fnDiag.rebuildCount  (incremented by buildFootnoteMap)
//   window.__fnDiag.domMutations  (populated by lazyLoaderFactory)
if (typeof window !== 'undefined') {
  const w = window as any;
  if (!w.__fnDiag) {
    // Tests will replace this with `window.__fnDiag = { enabled: true, ... }`
    // before navigating. When `enabled` is falsy we still record snapshot()
    // results (cheap) but skip per-mutation accumulation in hot paths.
    w.__fnDiag = { enabled: false, rebuildCount: 0, domMutations: [] };
  }
  w.__fnDiag.snapshot = () => ({
    bookId: currentBookId,
    mapEntries: Array.from(footnoteMap.entries()),
    rebuildCount: w.__fnDiag.rebuildCount || 0,
  });
}

/**
 * Build the footnote numbering map for a book.
 * Sorts nodes by startLine and assigns sequential numbers to footnote IDs.
 */
export function buildFootnoteMap(bookId: string, nodes: any[]): Map<string, number | string> {
  if (typeof window !== 'undefined' && (window as any).__fnDiag) {
    (window as any).__fnDiag.rebuildCount = ((window as any).__fnDiag.rebuildCount || 0) + 1;
  }

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

  // Collect all footnotes in document order
  // Supports both old format (string ID) and new format ({id, marker} object)
  const orderedFootnotes: Array<{ id: string; marker: string | null }> = [];
  const seenIds = new Set<string>();

  // Use nodes.footnotes arrays (kept in sync during saves in batch.js)
  for (const node of sortedNodes) {
    if (node.footnotes && Array.isArray(node.footnotes)) {
      for (const footnote of node.footnotes) {
        // Handle both formats: string (old) or object {id, marker} (new)
        const footnoteId = typeof footnote === 'string' ? footnote : footnote?.id;
        const marker = typeof footnote === 'string' ? null : footnote?.marker;

        if (footnoteId && !seenIds.has(footnoteId)) {
          orderedFootnotes.push({ id: footnoteId, marker: marker });
          seenIds.add(footnoteId);
        }
      }
    }
  }

  // Build the maps
  // Only numeric markers get sequential numbers; non-numeric markers keep their original value
  footnoteMap.clear();
  reverseMap.clear();

  let numericCounter = 1;
  for (const footnote of orderedFootnotes) {
    const { id, marker } = footnote;

    // Check if marker should be preserved (intentional non-numeric like *, †, 23a, 43b)
    // NOT preserved: empty, missing, "?", or pure numeric markers
    const shouldPreserveMarker = marker &&
      marker !== '?' &&
      !/^\d+$/.test(marker);

    if (shouldPreserveMarker) {
      // Intentional non-numeric markers keep their original value
      footnoteMap.set(id, marker!);
      // Don't add to reverseMap since marker isn't a sequential number
    } else {
      // Numeric markers and placeholders get sequential numbers
      footnoteMap.set(id, numericCounter);
      reverseMap.set(numericCounter, id);
      numericCounter++;
    }
  }

  if (footnoteMap.size > 0) {
    verbose.content(`Built footnote map with ${footnoteMap.size} entries for book ${bookId}`, 'FootnoteNumberingService.js');
  }

  return footnoteMap;
}

/**
 * Check if a value is a footnote ID (new format) vs display number (old format)
 */
export function isFootnoteId(value: any): boolean {
  if (!value || typeof value !== 'string') return false;
  // New format contains "_Fn" (e.g., "bookId_Fn1758412345001")
  // Old format is just a number (e.g., "1", "2")
  return value.includes('_Fn') || value.includes('Fn');
}

/**
 * Get display number for a footnote ID
 */
export function getDisplayNumber(footnoteId: string | null | undefined): number | string | null {
  if (!footnoteId) return null;
  return footnoteMap.get(footnoteId) || null;
}

/**
 * Get footnote ID for a display number
 */
export function getFootnoteId(displayNumber: number): string | null {
  return reverseMap.get(displayNumber) || null;
}

/**
 * Get current book ID for the cached map
 */
export function getCurrentBookId(): string | null {
  return currentBookId;
}

/**
 * Get current map (for debugging/testing) — a defensive copy.
 */
export function getCurrentMap(): Map<string, number | string> {
  return new Map(footnoteMap);
}

/**
 * Get map size
 */
export function getMapSize(): number {
  return footnoteMap.size;
}

/**
 * Check if nodes contain old-format footnotes (display numbers instead of IDs)
 */
export function hasOldFormatFootnotes(nodes: any[]): boolean {
  for (const node of nodes) {
    if (node.footnotes && node.footnotes.length > 0) {
      const firstFootnote = node.footnotes[0];
      // Handle both string format and object format {id, marker}
      const footnoteId = typeof firstFootnote === 'string' ? firstFootnote : firstFootnote?.id;
      // Old format: simple numbers like "1", "2"
      // New format: IDs like "bookId_Fn1758412345001" or objects with id property
      if (footnoteId && !isFootnoteId(footnoteId)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Clear cache (for book switching or cleanup)
 */
export function clearCache(): void {
  footnoteMap.clear();
  reverseMap.clear();
  currentBookId = null;
  verbose.content('Footnote cache cleared', 'FootnoteNumberingService.js');
}
