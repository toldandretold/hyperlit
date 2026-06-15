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

import { log, verbose } from '../utilities/logger.js';
import { buildFootnoteMap, getCurrentMap, getMapSize } from './footnoteCache';
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
export async function rebuildAndRenumber(bookId: string, nodes: any[]): Promise<void> {
  verbose.content(`Rebuilding footnote map for book ${bookId}`, 'FootnoteNumberingService.js');

  // [diagnostic] capture caller + scope to debug integrity-mismatch
  const __callerStack = new Error('rebuildAndRenumber caller').stack;
  const __isSubBook = typeof bookId === 'string' && bookId.includes('/');
  console.log(`[diag][renumber] called for bookId=${bookId} isSubBook=${__isSubBook} nodeCount=${(nodes||[]).length}`);
  console.log(`[diag][renumber] caller stack:\n${__callerStack}`);

  buildFootnoteMap(bookId, nodes);

  // [diagnostic] dump map after build
  try {
    const mapDump = Array.from(getCurrentMap().entries()).map(([id, n]) => `${id}=${n}`);
    console.log(`[diag][renumber] footnoteMap size=${getMapSize()}`, mapDump);
  } catch (e) {}

  const affectedStartLines = updateFootnoteNumbersInDOM();

  // [diagnostic] report which DOM nodes the renumber touched
  console.log(`[diag][renumber] DOM updates affected ${affectedStartLines.size} startLines`, Array.from(affectedStartLines));

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
async function reconcileStoredFootnoteContent(bookId: string, skipStartLines: Set<any> = new Set()): Promise<number> {
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
      console.error('[reconcile] cursor error', e.target?.error);
    };

    tx.oncomplete = () => {
      for (const { updated, original } of writtenUpdates) {
        queueForSync('nodes', updated.startLine, 'update', updated, original);
      }
      if (writtenUpdates.length > 0) {
        console.log(`📝 Reconciled stored footnote numbers in ${writtenUpdates.length} non-rendered node(s) for ${bookId}`);
      }
      resolve(writtenUpdates.length);
    };
    tx.onerror = (e: any) => {
      console.error('[reconcile] transaction error', e.target?.error);
      resolve(0);
    };
  });
}

/**
 * Persist renumbered footnotes to IndexedDB and queue for server sync.
 * Extracts updated HTML from DOM and saves to database.
 */
async function persistRenumberedNodes(bookId: string, affectedStartLines: Set<string>): Promise<void> {
  if (affectedStartLines.size === 0) return;

  try {
    const { batchUpdateIndexedDBRecords } = await import('../indexedDB/nodes/batch');

    // Convert startLines to records format expected by batchUpdateIndexedDBRecords
    const recordsToUpdate = Array.from(affectedStartLines).map(startLine => ({
      id: startLine
    }));

    // [diagnostic] dump DOM outerHTML for each affected startLine so we can
    // see what the renumbered DOM actually looks like at the moment we're
    // asking the batch path to persist. If the IDB content after this write
    // doesn't match what's logged here, the batch write path is dropping it.
    const bookContainer = document.querySelector(`[data-book-id="${bookId}"]`)
      || document.getElementById(bookId);
    if (bookContainer) {
      for (const startLine of affectedStartLines) {
        const el = bookContainer.querySelector(`[id="${startLine}"]`);
        if (el) {
          const html = el.outerHTML || '';
          const sups = Array.from(el.querySelectorAll('sup[fn-count-id]')).map(s => ({
            countId: s.getAttribute('fn-count-id'),
            text: s.textContent,
            id: s.id,
          }));
          console.log(`[diag][persist] startLine=${startLine} bookId=${bookId} sups=${JSON.stringify(sups)} htmlLen=${html.length}`);
        } else {
          console.log(`[diag][persist] startLine=${startLine} NOT FOUND in DOM (bookId=${bookId})`);
        }
      }
    } else {
      console.log(`[diag][persist] no container for bookId=${bookId} — sub-book closed?`);
    }

    await batchUpdateIndexedDBRecords(recordsToUpdate, { bookId, skipFootnoteRenumber: true });

    // [diagnostic] read back from IDB and report what actually got written
    try {
      const { getNodeChunksFromIndexedDB } = await import('../indexedDB/index');
      const after = await getNodeChunksFromIndexedDB(bookId);
      const byId = new Map((after || []).map(n => [String(n.startLine), n.content || '']));
      for (const startLine of affectedStartLines) {
        const stored = byId.get(String(startLine));
        if (stored === undefined) {
          console.log(`[diag][persist:after] startLine=${startLine} MISSING in IDB`);
          continue;
        }
        const m = stored.match(/<sup[^>]*fn-count-id="([^"]*)"[^>]*>([^<]*)</);
        console.log(`[diag][persist:after] startLine=${startLine} firstSup=${m ? `count=${m[1]} text=${m[2]}` : 'none'} storedLen=${stored.length}`);
      }
    } catch (e) {
      console.warn('[diag][persist:after] readback failed', e);
    }

    verbose.content(`Persisted ${recordsToUpdate.length} renumbered nodes via batch update`, 'FootnoteNumberingService.js');
  } catch (error) {
    log.error('Error persisting renumbered nodes', 'FootnoteNumberingService.js', error as any);
  }
}
