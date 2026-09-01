/**
 * Transform Helpers
 * Shared utility functions for DOM transformation across format processors
 * Reduces code duplication in journal-specific processors (Sage, Springer, etc.)
 */

import { unwrap, wrapLooseNodes, isReferenceSectionHeading } from './dom-utils';

/**
 * Unwrap container elements (div, article, section, etc.) from DOM
 * Wraps loose text nodes in paragraphs before unwrapping
 * Processes in reverse order to handle nested containers correctly
 *
 * @param {HTMLElement} dom - DOM element to process
 * @param {string} additionalSelectors - Additional selectors to unwrap (e.g., 'ul, ol')
 */
export function unwrapContainers(dom: any, additionalSelectors = '') {
  const baseSelectors = 'div, article, section, main, header, footer, aside, nav, button';
  const selectors = additionalSelectors ? `${baseSelectors}, ${additionalSelectors}` : baseSelectors;

  const containers = Array.from<any>(dom.querySelectorAll(selectors));

  // Process in reverse order (children before parents)
  containers.reverse().forEach((container: any) => {
    wrapLooseNodes(container);
    unwrap(container);
  });

  // Also unwrap <font> tags
  dom.querySelectorAll('font').forEach(unwrap);
}

// Markers that identify a table as a genuine DATA table — never unwrapped.
const DATA_TABLE_MARKER_SELECTOR = 'th, thead, tfoot, caption, col, colgroup, td[headers]';

// Block-level content inside a <td> means the cell holds document flow, not
// tabular data — a data cell's content is inline by definition.
const CELL_BLOCK_CONTENT_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure, center, address, hr';

/**
 * Rows/cells belonging to THIS table/row only. Not table.rows / row.cells:
 * jsdom leaks NESTED tables' rows and cells into those collections, which made
 * the outer unwrap gut an inner data table's cells.
 */
function ownTableRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll('tr')).filter(
    (row) => row.closest('table') === table,
  ) as HTMLTableRowElement[];
}

function ownRowCells(row: HTMLTableRowElement): HTMLTableCellElement[] {
  return Array.from(row.children).filter(
    (el) => el.tagName === 'TD' || el.tagName === 'TH',
  ) as HTMLTableCellElement[];
}

/**
 * Decide whether a <table> is a LAYOUT table (a 1990s-style page-structure
 * wrapper) rather than a data table. Layout tables get dissolved so their
 * content splits into real nodes instead of one giant unsplittable table blob.
 *
 * Heuristics (Readability-style):
 * - role="presentation"/"none" → layout, always.
 * - Any data-table marker (th/thead/tfoot/caption/col/colgroup/summary/
 *   td[headers]/role="grid|table") belonging to THIS table → data, keep.
 * - A cell containing block elements (p, h1–h6, blockquote, …) → layout.
 * - Single-column tables (every row ≤ 1 cell) → layout.
 * - Single-row tables with one cell, or with a whitespace-only spacer cell → layout.
 *
 * Judges each table on its OWN rows/cells only, so nested tables are
 * classified independently — a data table nested inside a layout wrapper
 * survives.
 *
 * @param {HTMLTableElement} table - Table element to classify
 * @returns {boolean} - True if the table is layout scaffolding
 */
export function isLayoutTable(table: HTMLTableElement): boolean {
  const role = (table.getAttribute('role') || '').toLowerCase();
  if (role === 'presentation' || role === 'none') return true;
  if (role === 'grid' || role === 'table') return false;
  if (table.hasAttribute('summary')) return false;

  const hasOwnDataMarker = Array.from(
    table.querySelectorAll(DATA_TABLE_MARKER_SELECTOR),
  ).some((el) => el.closest('table') === table);
  if (hasOwnDataMarker) return false;

  const rows = ownTableRows(table);
  if (rows.length === 0) return true;
  const cells = rows.flatMap(ownRowCells);

  if (cells.some((cell) => cell.querySelector(CELL_BLOCK_CONTENT_SELECTOR))) return true;
  if (rows.every((row) => ownRowCells(row).length <= 1)) return true;
  if (rows.length === 1) {
    if (cells.length === 1) return true;
    const isSpacerCell = (cell: HTMLTableCellElement) =>
      !(cell.textContent || '').trim() && !cell.querySelector('img');
    if (cells.some(isSpacerCell)) return true;
  }

  return false;
}

/**
 * Dissolve layout tables in place: each cell's loose inline content is wrapped
 * in <p>, then all cell children are promoted to where the table stood, in
 * document order, and the table/tr/td scaffolding is removed. Data tables
 * (per isLayoutTable) are left untouched.
 *
 * Processes innermost-first so nested layout tables dissolve before their
 * parents are classified.
 *
 * @param {HTMLElement} dom - DOM element to process
 * @returns {number} - Number of layout tables unwrapped
 */
export function unwrapLayoutTables(dom: Element): number {
  const tables = Array.from(dom.querySelectorAll('table')).reverse();
  let unwrapped = 0;

  tables.forEach((table) => {
    const t = table as HTMLTableElement;
    if (!isLayoutTable(t)) return;

    const parent = t.parentNode;
    if (!parent) return;

    for (const row of ownTableRows(t)) {
      for (const cell of ownRowCells(row)) {
        wrapLooseNodes(cell, t.ownerDocument);
        while (cell.firstChild) {
          parent.insertBefore(cell.firstChild, t);
        }
      }
    }
    t.remove();
    unwrapped++;
  });

  return unwrapped;
}

/**
 * Remove sections from DOM based on heading text matching
 * Removes the heading and all following content until the next heading
 *
 * @param {HTMLElement} dom - DOM element to process
 * @param {Function} headingMatcher - Function to test heading text (default: isReferenceSectionHeading)
 * @returns {number} - Number of sections removed
 */
export function removeSectionsByHeading(dom: any, headingMatcher = isReferenceSectionHeading) {
  const headings = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let removedCount = 0;

  headings.forEach((heading: any) => {
    if (headingMatcher(heading.textContent.trim())) {
      let nextElement = heading.nextElementSibling;
      heading.remove();
      removedCount++;

      // Remove all content until next heading or end
      while (nextElement) {
        const next = nextElement.nextElementSibling;
        if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
          break; // Hit another heading, stop
        }
        nextElement.remove();
        nextElement = next;
      }
    }
  });

  return removedCount;
}

/**
 * Remove elements with data-static-content attribute
 * These are sections that have already been extracted and will be re-appended
 *
 * @param {HTMLElement} dom - DOM element to process
 * @returns {number} - Number of elements removed
 */
export function removeStaticContentElements(dom: any) {
  const staticElements = dom.querySelectorAll('[data-static-content]');
  const count = staticElements.length;
  staticElements.forEach((el: any) => el.remove());
  return count;
}

/**
 * Clone an element and clean it by stripping styles and optionally removing elements
 * Used during footnote/reference extraction to avoid modifying the original DOM
 *
 * @param {HTMLElement} element - Element to clone
 * @param {Array<string>} selectorsToRemove - CSS selectors for elements to remove from clone
 * @returns {HTMLElement} - Cleaned clone
 */
export function cloneAndClean(element: any, selectorsToRemove: any[] = []) {
  const clone = element.cloneNode(true);

  // Strip all inline styles
  clone.querySelectorAll('[style]').forEach((el: any) => el.removeAttribute('style'));

  // Remove specified elements
  if (selectorsToRemove.length > 0) {
    clone.querySelectorAll(selectorsToRemove.join(', ')).forEach((el: any) => el.remove());
  }

  return clone;
}

/**
 * Check if text looks like a valid bibliographic reference
 * Validates presence of year and minimum length
 *
 * @param {string} text - Text content to validate
 * @param {Object} options - Validation options
 * @param {number} options.minLength - Minimum text length (default: 20)
 * @param {number} options.maxYearPosition - Maximum position of year in text (default: 150)
 * @returns {boolean} - True if text appears to be a valid reference
 */
export function isValidReference(text: any, options: any = {}) {
  const { minLength = 20, maxYearPosition = 150 } = options;

  if (!text || text.length < minLength) {
    return false;
  }

  const yearMatch = text.match(/\d{4}[a-z]?/);
  return yearMatch && yearMatch.index < maxYearPosition;
}

/**
 * Add a reference to array only if not already present (avoids duplicates)
 *
 * @param {Array} references - Array of reference objects
 * @param {Object} newRef - New reference object to add
 * @param {string} keyField - Field to use for duplicate comparison (default: 'originalText')
 * @returns {boolean} - True if reference was added, false if duplicate
 */
export function addUniqueReference(references: any, newRef: any, keyField = 'originalText') {
  if (!references.find((r: any) => r[keyField] === newRef[keyField])) {
    references.push(newRef);
    return true;
  }
  return false;
}

/**
 * Reformat a citation link to show only the year as the clickable link
 * Handles both narrative and parenthetical citation styles
 *
 * Narrative: "Author (2022)" → Author (<a>2022</a>)
 * Parenthetical: "Author, 2022" → Author, <a>2022</a>
 *
 * @param {HTMLElement} link - The citation link element to reformat
 * @param {Object} options - Reformatting options
 * @param {string} options.author - Author text to insert before the link
 * @param {string} options.year - Year to use as link text
 * @param {boolean} options.isNarrative - True for narrative style (adds parentheses around year)
 * @param {string} options.trailing - Any trailing text after the year (e.g., ": 143")
 */
export function reformatCitationLink(link: any, { author = '', year = '', isNarrative = false, trailing = '' }: any) {
  if (!year) return;

  if (isNarrative) {
    // NARRATIVE: "Author (Year)" → Author (<a>Year</a>)
    if (author) {
      const authorText = document.createTextNode(author + ' ');
      link.parentNode.insertBefore(authorText, link);
    }

    // Insert opening bracket before link
    const openBracket = document.createTextNode('(');
    link.parentNode.insertBefore(openBracket, link);

    // Set link text to only the year
    link.textContent = year;

    // Insert closing bracket after link
    const closeBracket = document.createTextNode(')');
    link.parentNode.insertBefore(closeBracket, link.nextSibling);
  } else {
    // PARENTHETICAL: "Author, Year" → Author, <a>Year</a>
    if (author) {
      const authorText = document.createTextNode(author);
      link.parentNode.insertBefore(authorText, link);
    }

    // Set link text to only the year
    link.textContent = year;

    // Handle any trailing text after the year (e.g., ": 143" in page citations)
    if (trailing) {
      const trailingText = document.createTextNode(trailing);
      link.parentNode.insertBefore(trailingText, link.nextSibling);
    }
  }
}

/**
 * Clean Taylor & Francis footnote content by removing wrapper spans and cleaning citation attributes
 * This pattern is repeated multiple times in taylor-francis-processor.js
 *
 * @param {string} htmlContent - Raw HTML content from footnote
 * @returns {string} - Cleaned HTML content
 */
export function cleanTFFootnoteContent(htmlContent: any) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;

  // Remove citation wrapper spans (unwrap their content)
  tempDiv.querySelectorAll('span.ref-lnk').forEach((span: any) => {
    while (span.firstChild) {
      span.parentNode.insertBefore(span.firstChild, span);
    }
    span.remove();
  });

  // Clean citation links - keep data-rid for T&F linkCitations() to process
  tempDiv.querySelectorAll('a[data-rid^="CIT"]').forEach((link: any) => {
    // Remove off-screen spans
    link.querySelectorAll('span.off-screen').forEach((s: any) => s.remove());

    // Remove problematic attributes but KEEP data-rid
    link.removeAttribute('data-behaviour');
    link.removeAttribute('data-ref-type');
    link.removeAttribute('data-label');
    link.removeAttribute('data-registered');
    link.removeAttribute('href'); // Remove temporary href, T&F linkCitations will add proper one
  });

  return tempDiv.innerHTML;
}
