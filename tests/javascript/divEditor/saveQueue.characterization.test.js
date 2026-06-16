/**
 * Characterization of resources/js/divEditor/saveQueue.js — the SaveQueue class,
 * the debounced DOM → IndexedDB write path. Pinned before .js → .ts.
 *
 * Focus on the durable contract (not the integrity/self-heal machinery, which is
 * deferred via setTimeout/requestIdleCallback and exercised by e2e):
 *   - queueNode: pending shape + dedupe by id
 *   - queueDeletion: bookId resolution priority + data-node-id capture
 *   - flush → batchUpdateIndexedDBRecords, GROUPED by effective bookId
 *     (node.bookId || this.bookId — the SaveQueue.bookId inheritance gotcha)
 *   - flush → batchDeleteIndexedDBRecords, grouped by book
 *   - DOM-missing nodes are skipped on save
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { batchUpdate, batchDelete, deleteWithRetry } = vi.hoisted(() => ({
  batchUpdate: vi.fn().mockResolvedValue(undefined),
  batchDelete: vi.fn().mockResolvedValue(undefined),
  deleteWithRetry: vi.fn().mockResolvedValue(undefined),
}));
// Spy the three write fns; keep the rest of the barrel real for transitive importers.
vi.mock('../../../resources/js/indexedDB/index', async (importOriginal) => ({
  ...(await importOriginal()),
  batchUpdateIndexedDBRecords: batchUpdate,
  batchDeleteIndexedDBRecords: batchDelete,
  deleteIndexedDBRecordWithRetry: deleteWithRetry,
}));
// Fire-and-forget side effects → no-ops so they can't interfere with the save path.
vi.mock('../../../resources/js/lazyLoader/utilities/cacheState', () => ({ markCacheDirty: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/utilities/chunkLoadingState', () => ({ clearChunkLoadingInProgress: vi.fn() }));
vi.mock('../../../resources/js/search/inTextSearch/searchToolbar', () => ({ invalidateSearchIndex: vi.fn() }));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({ TAB_ID: 'test-tab', markBookEditedLocally: vi.fn() }));
vi.mock('../../../resources/js/integrity/verifier', () => ({ verifyNodesIntegrity: vi.fn().mockResolvedValue({ ok: [], mismatches: [], missingFromIDB: [], duplicateIds: [] }), findOrphanedNodes: () => [], healVerbatimDuplicates: () => [] }));
vi.mock('../../../resources/js/integrity/reporter', () => ({ reportIntegrityFailure: vi.fn() }));
vi.mock('../../../resources/js/paste/ui/pasteUndoToast', () => ({ hidePasteUndoToast: vi.fn() }));
vi.mock('../../../resources/js/paste/handlers/largePasteHandler', () => ({ clearPasteSnapshot: vi.fn() }));
// Mock ../paste and ../app.js to keep this test LIGHT (they'd otherwise drag in the
// whole paste/search/app transitive graph). NB: these are no longer needed to dodge
// the circular-import TDZ — index.js now imports `debounce` from the zero-import leaf,
// so importing saveQueue directly no longer crashes on the saveQueue↔index cycle.
vi.mock('../../../resources/js/paste', () => ({ isPasteOperationActive: () => false }));
vi.mock('../../../resources/js/app.js', () => ({ book: 'currentBook' }));

import { SaveQueue } from '../../../resources/js/divEditor/saveQueue.js';

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  globalThis.BroadcastChannel = class { postMessage() {} close() {} };
});

describe('queueNode', () => {
  it('stores {id, action, bookId} keyed by id and dedupes', () => {
    const sq = new SaveQueue('bookA');
    sq.queueNode('3', 'update');
    sq.queueNode('3', 'update');            // same id again
    sq.queueNode('5', 'add', 'bookB');
    expect(sq.pendingSaves.nodes.size).toBe(2);
    expect(sq.pendingSaves.nodes.get('3')).toEqual({ id: '3', action: 'update', bookId: null });
    expect(sq.pendingSaves.nodes.get('5')).toEqual({ id: '5', action: 'add', bookId: 'bookB' });
    sq.destroy();
  });
});

describe('queueDeletion bookId resolution', () => {
  it('prefers explicit bookId and captures data-node-id', () => {
    const el = document.createElement('p'); el.id = '7'; el.setAttribute('data-node-id', 'N7');
    document.body.appendChild(el);
    const sq = new SaveQueue('bookA');
    sq.queueDeletion('7', el, 'explicitBook');
    expect(sq.pendingSaves.deletionMap.get('7')).toEqual({ dataNodeId: 'N7', bookId: 'explicitBook' });
    sq.destroy();
  });

  it('falls back to the element\'s closest [data-book-id], then .main-content id', () => {
    const sub = document.createElement('div'); sub.setAttribute('data-book-id', 'subBookX');
    const elA = document.createElement('p'); elA.id = '8'; sub.appendChild(elA);
    document.body.appendChild(sub);
    const main = document.createElement('div'); main.className = 'main-content'; main.id = 'bookMain';
    const elB = document.createElement('p'); elB.id = '9'; main.appendChild(elB);
    document.body.appendChild(main);

    const sq = new SaveQueue('bookA');
    sq.queueDeletion('8', elA);   // inside a sub-book
    sq.queueDeletion('9', elB);   // not in a sub-book → main-content id
    expect(sq.pendingSaves.deletionMap.get('8').bookId).toBe('subBookX');
    expect(sq.pendingSaves.deletionMap.get('9').bookId).toBe('bookMain');
    sq.destroy();
  });
});

describe('flush → IndexedDB writes, grouped by effective bookId', () => {
  it('groups update records by (node.bookId || this.bookId) and calls batchUpdate per book', async () => {
    ['3', '5'].forEach(id => { const el = document.createElement('p'); el.id = id; document.body.appendChild(el); });
    const sq = new SaveQueue('bookA');
    sq.queueNode('3', 'update');             // inherits this.bookId → bookA
    sq.queueNode('5', 'update', 'bookB');     // explicit → bookB
    await sq.flush();

    expect(batchUpdate).toHaveBeenCalledTimes(2);
    const byBook = Object.fromEntries(batchUpdate.mock.calls.map(([recs, opts]) => [opts.bookId, recs.map(r => r.id)]));
    expect(byBook.bookA).toEqual(['3']);
    expect(byBook.bookB).toEqual(['5']);
    sq.destroy();
  });

  it('skips nodes whose DOM element is gone', async () => {
    const el = document.createElement('p'); el.id = '3'; document.body.appendChild(el);
    const sq = new SaveQueue('bookA');
    sq.queueNode('3', 'update');
    sq.queueNode('404', 'update');           // no element in DOM
    await sq.flush();
    const saved = batchUpdate.mock.calls.flatMap(([recs]) => recs.map(r => r.id));
    expect(saved).toEqual(['3']);
    sq.destroy();
  });

  it('routes queued deletions through batchDelete grouped by book', async () => {
    const sq = new SaveQueue('bookA');
    sq.queueDeletion('7', null, 'bookA');
    sq.queueDeletion('8', null, 'bookB');
    await sq.flush();
    expect(batchDelete).toHaveBeenCalledTimes(2);
    const books = batchDelete.mock.calls.map(([, , bookId]) => bookId).sort();
    expect(books).toEqual(['bookA', 'bookB']);
    sq.destroy();
  });
});
