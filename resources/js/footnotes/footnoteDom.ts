/**
 * footnoteDom — DOM/HTML transforms for footnote numbering.
 *
 * Pure-ish DOM work (no IndexedDB): rewrite visible sup numbers, apply the map
 * to a detached HTML string, and migrate old-format footnote arrays by reading
 * the rendered HTML. Depends only on the footnoteCache leaf.
 */

import { verbose } from '../utilities/logger';
import { isFootnoteId, getDisplayNumber, hasOldFormatFootnotes } from './footnoteCache';

/**
 * Extract footnote IDs from HTML content when nodes.footnotes has old format.
 * (Retained from the original service; the live extractor lives in
 * indexedDB/hydration/rebuild.ts.)
 */
export function extractFootnoteIdsFromContent(nodes: any[], orderedFootnoteIds: string[], seenIds: Set<string>): void {
  for (const node of nodes) {
    if (!node.content) continue;

    // Create a temporary element to parse HTML
    const temp = document.createElement('div');
    temp.innerHTML = node.content;

    // Find all footnote sups - support both old and new formats:
    // Old format: <sup fn-count-id="2" id="bookIdFn...ref"><a href="#bookIdFn...">2</a></sup>
    // New format: <sup fn-count-id="2" id="bookId_Fn..."><a class="footnote-ref" href="#bookId_Fn...">2</a></sup>
    const footnoteSups = temp.querySelectorAll('sup[fn-count-id]');

    for (const sup of footnoteSups) {
      // New format: sup.id directly contains footnoteId (no "ref" suffix)
      // Old format fallback: extract from anchor href
      let footnoteId = sup.id;

      // If sup.id has "ref" suffix (old format), strip it
      if (footnoteId && footnoteId.endsWith('ref')) {
        footnoteId = footnoteId.slice(0, -3);
      }

      // Fallback to href if no valid id
      if (!footnoteId || !isFootnoteId(footnoteId)) {
        const link = sup.querySelector('a');
        const href = link?.getAttribute('href');
        if (href) {
          footnoteId = href.replace(/^#/, '');
        }
      }

      if (footnoteId && !seenIds.has(footnoteId) && isFootnoteId(footnoteId)) {
        orderedFootnoteIds.push(footnoteId);
        seenIds.add(footnoteId);
      }
    }
  }
}

/**
 * Apply the current footnote map to the sup elements inside a stored HTML
 * string. Returns { changed, newContent }. Mirrors the per-sup logic in
 * updateFootnoteNumbersInDOM but operates on detached HTML so it works for
 * nodes that aren't currently rendered.
 */
export function applyFootnoteMapToStoredHTML(html: string): { changed: boolean; newContent: string } {
  if (!html) return { changed: false, newContent: html };

  const temp = document.createElement('div');
  temp.innerHTML = html;

  let changed = false;
  const sups = temp.querySelectorAll('sup[fn-count-id]');
  for (const sup of sups) {
    let footnoteId = sup.id;
    if (footnoteId && footnoteId.endsWith('ref')) {
      footnoteId = footnoteId.slice(0, -3);
    }
    if (!footnoteId) {
      const link = sup.querySelector('a');
      const href = link?.getAttribute('href');
      if (href) footnoteId = href.replace(/^#/, '');
    }
    if (!footnoteId) continue;

    const currentValue = sup.getAttribute('fn-count-id');
    // Preserve intentional non-numeric markers (*, †, 43a) — but renumber "?" placeholders
    const shouldPreserveMarker = currentValue && currentValue !== '?' && !/^\d+$/.test(currentValue);
    if (shouldPreserveMarker) continue;

    const displayNumber = getDisplayNumber(footnoteId);
    if (!displayNumber || typeof displayNumber !== 'number') continue;

    const newValue = displayNumber.toString();
    if (currentValue !== newValue) {
      sup.setAttribute('fn-count-id', newValue);
      const link = sup.querySelector('a');
      if (link) {
        link.textContent = newValue;
      } else {
        sup.textContent = newValue;
      }
      changed = true;
    }
  }

  if (!changed) return { changed: false, newContent: html };

  const newContent = temp.firstElementChild
    ? temp.firstElementChild.outerHTML
    : temp.innerHTML;
  return { changed: true, newContent };
}

/**
 * Update all visible footnote numbers in the DOM.
 * Called after rebuildAndRenumber or when chunks are loaded.
 *
 * @returns Set of startLine IDs that were modified
 */
export function updateFootnoteNumbersInDOM(): Set<string> {
  const affectedStartLines = new Set<string>();

  // Find all footnote reference sups in the DOM - support both old and new formats
  // New format: <sup fn-count-id="2" id="Fn..." class="footnote-ref">2</sup>
  // Old format: <sup fn-count-id="2" id="..."><a class="footnote-ref" href="#bookIdFn...">2</a></sup>
  const footnoteSups = document.querySelectorAll('sup[fn-count-id]');

  for (const sup of footnoteSups) {
    // Get footnoteId from sup.id (works for both new and old formats)
    let footnoteId = sup.id;

    // Strip "ref" suffix if present (very old format)
    if (footnoteId && footnoteId.endsWith('ref')) {
      footnoteId = footnoteId.slice(0, -3);
    }

    // Fallback to href if no valid id (old format with anchor)
    if (!footnoteId) {
      const link = sup.querySelector('a');
      const href = link?.getAttribute('href');
      if (href) {
        footnoteId = href.replace(/^#/, '');
      }
    }

    if (!footnoteId) continue;

    // Check if this footnote has an intentional non-numeric marker (*, †, 43a, etc.)
    // If so, preserve the original marker - don't renumber it
    // Note: "?" is a placeholder for new footnotes and SHOULD be renumbered
    const currentValue = sup.getAttribute('fn-count-id');
    const shouldPreserveMarker = currentValue &&
      currentValue !== '?' &&
      !/^\d+$/.test(currentValue);

    if (shouldPreserveMarker) {
      // Skip renumbering for intentional non-numeric markers (*, 43a, 26a, etc.)
      // These are preserved from the original document
      continue;
    }

    // Get the new display number for numeric footnotes
    const displayNumber = getDisplayNumber(footnoteId);
    if (displayNumber) {
      const newValue = displayNumber.toString();

      if (currentValue !== newValue) {
        sup.setAttribute('fn-count-id', newValue);

        // Update the visible text - check for anchor (old format) or direct text (new format)
        const link = sup.querySelector('a');
        if (link) {
          // Old format: update anchor text
          link.textContent = newValue;
        } else {
          // New format: update sup text directly
          sup.textContent = newValue;
        }

        // Track the affected node by finding parent block element with numeric startLine id
        const nodeElement = sup.closest('p[id], div[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], pre[id]');
        if (nodeElement && nodeElement.id && /^\d+(\.\d+)?$/.test(nodeElement.id)) {
          affectedStartLines.add(nodeElement.id);
        }
      }
    }
  }

  // Also update footnote definition anchors if visible
  const footnoteDefinitions = document.querySelectorAll('a[id][fn-count-id]');
  for (const anchor of footnoteDefinitions) {
    const footnoteId = anchor.id;
    if (!footnoteId || !isFootnoteId(footnoteId)) continue;

    // Skip intentional non-numeric markers (but not "?" placeholder)
    const currentValue = anchor.getAttribute('fn-count-id');
    const shouldPreserve = currentValue && currentValue !== '?' && !/^\d+$/.test(currentValue);
    if (shouldPreserve) continue;

    const displayNumber = getDisplayNumber(footnoteId);
    if (displayNumber) {
      anchor.setAttribute('fn-count-id', displayNumber.toString());
    }
  }

  return affectedStartLines;
}

/**
 * Migrate old-format footnotes (display numbers) to new format (footnote IDs).
 * This updates nodes.footnotes arrays to use IDs instead of numbers.
 *
 * @returns Updated nodes array (also modifies in place)
 */
export async function migrateOldFormatFootnotes(bookId: string, nodes: any[]): Promise<any[]> {
  if (!hasOldFormatFootnotes(nodes)) {
    verbose.content('Nodes already in new format, no migration needed', 'FootnoteNumberingService.js');
    return nodes;
  }

  verbose.content(`Migrating old footnote format to new format for book ${bookId}...`, 'FootnoteNumberingService.js');

  // Build a map from display number to footnote ID by scanning HTML content
  const displayToId = new Map<string, string>();

  for (const node of nodes) {
    if (!node.content) continue;

    const temp = document.createElement('div');
    temp.innerHTML = node.content;

    // Find all footnote sups - check both old format and new format
    // Old format: <sup fn-count-id="2" id="...ref"><a href="#bookIdFn...">2</a></sup>
    // New format: <sup fn-count-id="2" id="bookId_Fn..."><a class="footnote-ref" href="#bookId_Fn...">2</a></sup>
    const footnoteSups = temp.querySelectorAll('sup[fn-count-id]');
    for (const sup of footnoteSups) {
      const displayNum = sup.getAttribute('fn-count-id');

      // New format: sup.id directly contains footnoteId
      // Old format: sup.id has "ref" suffix, or extract from anchor href
      let footnoteId = sup.id;

      // Strip "ref" suffix if present (old format)
      if (footnoteId && footnoteId.endsWith('ref')) {
        footnoteId = footnoteId.slice(0, -3);
      }

      // Fallback to href if no valid id
      if (!footnoteId || !isFootnoteId(footnoteId)) {
        const link = sup.querySelector('a');
        const href = link?.getAttribute('href');
        if (href) {
          footnoteId = href.replace(/^#/, '');
        }
      }

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
      node.footnotes = node.footnotes.map((displayNum: any) => {
        const footnoteId = displayToId.get(displayNum);
        if (footnoteId) {
          migratedCount++;
          return footnoteId;
        }
        return displayNum; // Keep original if no mapping found
      });
    }
  }

  verbose.content(`Migration complete: ${migratedCount} footnote references migrated`, 'FootnoteNumberingService.js');

  // Note: The caller should save the updated nodes to IndexedDB if needed
  return nodes;
}
