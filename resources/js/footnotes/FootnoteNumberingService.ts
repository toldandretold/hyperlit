import { asBookId, LATEST, type BookId } from "../indexedDB/types";
/**
 * FootnoteNumberingService
 *
 * Manages dynamic footnote numbering based on document position (startLine).
 * Stores footnote IDs in nodes.footnotes, calculates display numbers on demand.
 *
 * This solves the problem of renumbering footnotes when inserting/deleting -
 * instead of storing display numbers (1, 2, 3), we store unique IDs and
 * calculate display numbers dynamically based on document order.
 *
 * This file is the IDB-touching orchestrator (`rebuildAndRenumber` + the
 * persist/reconcile writers) and the public barrel. The numbering core lives in
 * the `./footnoteCache` leaf; the DOM/HTML transforms live in `./footnoteDom`.
 */

import { log, verbose } from '../utilities/logger';
import { asLineId } from '../utilities/idHelpers';
import { buildFootnoteMap, getMapSize } from './footnoteCache';
import { updateFootnoteNumbersInDOM, applyFootnoteMapToStoredHTML } from './footnoteDom';

// Public API — re-exported so every existing importer of this module is unchanged.
export {
  buildFootnoteMap,
  isFootnoteId,
  getDisplayNumber,
  getFootnoteId,
  getCurrentBookId,
  getCurrentMap,
  getMapSize,
  hasOldFormatFootnotes,
  clearCache,
} from './footnoteCache';
export {
  extractFootnoteIdsFromContent,
  applyFootnoteMapToStoredHTML,
  updateFootnoteNumbersInDOM,
  migrateOldFormatFootnotes,
} from './footnoteDom';

/**
 * Rebuild map and trigger DOM update.
 * Called when footnotes are added/deleted.
 */
export async function rebuildAndRenumber(bookId: BookId, nodes: any[]): Promise<void> {
  verbose.content(`Rebuilding footnote map for book ${bookId}`, 'FootnoteNumberingService.js');

  buildFootnoteMap(bookId, nodes);

  const affectedStartLines = updateFootnoteNumbersInDOM();

  // Persist updated fn-count-id values for currently-rendered nodes via the
  // DOM-based batch path (also handles highlights/cites).
  if (affectedStartLines.size > 0) {
    await persistRenumberedNodes(bookId, affectedStartLines);
  }

  // Re-enabled 2026-05-27 after Playwright scenario C deterministically
  // reproduced the divergence (483-node book, 1 footnote insert at top → 111
  // stored nodes' fn-count-id values disagree with the dynamic map). The
  // map is the canonical side here — it reflects the just-completed edit;
  // stored HTML for non-rendered nodes is the stale side. See
  // tests/e2e/specs/footnotes/footnote-integrity.spec.js scenario C and
  // ~/.claude/plans/transient-wiggling-emerson.md.
  await reconcileStoredFootnoteContent(bookId, affectedStartLines);

  // Emit event for any listeners
  window.dispatchEvent(new CustomEvent('footnotesRenumbered', {
    detail: { bookId, count: getMapSize() }
  }));

  verbose.content(`Footnotes renumbered: ${getMapSize()} total`, 'FootnoteNumberingService.js');
}

/**
 * Walk every node in IDB for this book and rewrite stored sup numbers that
 * disagree with the current footnote map. Skips nodes that were already
 * persisted via the DOM path (those start lines come in via skipStartLines).
 *
 * Each updated node is queued for server sync so the server eventually
 * converges on the same numbers.
 */
async function reconcileStoredFootnoteContent(bookId: BookId, skipStartLines: Set<any> = new Set()): Promise<number> {
  const { openDatabase } = await import('../indexedDB/core/connection');
  const { queueForSync } = await import('../indexedDB/syncQueue/index');

  let db: any;
  try {
    db = await openDatabase();
  } catch (e) {
    log.error('Failed to open DB for footnote reconciliation', 'FootnoteNumberingService.js', e as any);
    return 0;
  }

  const skip = new Set([...skipStartLines].map(String));

  return new Promise<number>((resolve) => {
    const tx = db.transaction('nodes', 'readwrite');
    const store = tx.objectStore('nodes');
    const index = store.index('book');

    const writtenUpdates: Array<{ updated: any; original: any }> = [];

    const cursorReq = index.openCursor(IDBKeyRange.only(bookId));
    cursorReq.onsuccess = (e: any) => {
      const cursor = e.target.result;
      if (!cursor) return;

      const node = cursor.value;
      const skipThis =
        skip.has(String(node.startLine)) ||
        !node.content ||
        !node.footnotes ||
        node.footnotes.length === 0;

      if (!skipThis) {
        const { changed, newContent } = applyFootnoteMapToStoredHTML(node.content);
        if (changed) {
          const updated = { ...node, content: newContent };
          cursor.update(updated);
          writtenUpdates.push({ updated, original: node });
        }
      }

      cursor.continue();
    };
    cursorReq.onerror = (e: any) => {
      log.error('[reconcile] cursor error', 'FootnoteNumberingService.js', e.target?.error);
    };

    tx.oncomplete = () => {
      for (const { updated, original } of writtenUpdates) {
        queueForSync('nodes', updated.startLine, 'update', updated, original);
      }
      resolve(writtenUpdates.length);
    };
    tx.onerror = (e: any) => {
      log.error('[reconcile] transaction error', 'FootnoteNumberingService.js', e.target?.error);
      resolve(0);
    };
  });
}

/**
 * Persist renumbered footnotes to IndexedDB and queue for server sync.
 * Extracts updated HTML from DOM and saves to database.
 */
async function persistRenumberedNodes(bookId: BookId, affectedStartLines: Set<string>): Promise<void> {
  if (affectedStartLines.size === 0) return;

  try {
    const { batchUpdateIndexedDBRecords } = await import('../indexedDB/nodes/batch');

    // Convert startLines to records format expected by batchUpdateIndexedDBRecords
    const recordsToUpdate = Array.from(affectedStartLines).map(startLine => ({
      id: asLineId(startLine)
    }));

    await batchUpdateIndexedDBRecords(recordsToUpdate, { bookId, skipFootnoteRenumber: true });

    verbose.content(`Persisted ${recordsToUpdate.length} renumbered nodes via batch update`, 'FootnoteNumberingService.js');
  } catch (error) {
    log.error('Error persisting renumbered nodes', 'FootnoteNumberingService.js', error as any);
  }
}
