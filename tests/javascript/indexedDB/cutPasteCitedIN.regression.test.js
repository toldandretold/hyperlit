/**
 * REGRESSION — cut a hypercite citation anchor, re-paste it: the paste mints a
 * new id and appends to the source's citedIN; if the cut's delink was lost
 * (dropped mutation batch / muted observer) the source ended up with TWO
 * citations — one dead, red in the health check.
 *
 * Runs the REAL stores over fake-indexeddb (idbHarness) with the real
 * updateHyperciteInIndexedDB / updateCitationForExistingHypercite /
 * delinkHypercite / reconciliation modules; only the sync/broadcast side
 * effects are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne } from './idbHarness.js';

const mocks = vi.hoisted(() => ({
  updateBookTimestamp: vi.fn(async () => {}),
  queueForSync: vi.fn(),
  getNodesByDataNodeIDs: vi.fn(async () => []),
  rebuildNodeArrays: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  syncHyperciteWithNodeImmediately: vi.fn(async () => {}),
  queueNodeForSave: vi.fn(),
  broadcastToOpenTabs: vi.fn(),
}));

vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await import('../../../resources/js/indexedDB/core/connection');
  const util = await import('../../../resources/js/indexedDB/core/utilities');
  const hcRead = await import('../../../resources/js/indexedDB/hypercites/read');
  const nodesRead = await import('../../../resources/js/indexedDB/nodes/read');
  const hcIndex = await import('../../../resources/js/indexedDB/hypercites/index');
  return {
    openDatabase: conn.openDatabase,
    parseNodeId: util.parseNodeId,
    createNodeKey: util.createNodeKey,
    getHyperciteFromIndexedDB: hcRead.getHyperciteFromIndexedDB,
    getNodesFromIndexedDB: nodesRead.getNodesFromIndexedDB,
    updateHyperciteInIndexedDB: hcIndex.updateHyperciteInIndexedDB,
    updateCitationForExistingHypercite: hcIndex.updateCitationForExistingHypercite,
    updateBookTimestamp: mocks.updateBookTimestamp,
    queueForSync: mocks.queueForSync,
    getNodesByDataNodeIDs: mocks.getNodesByDataNodeIDs,
    rebuildNodeArrays: mocks.rebuildNodeArrays,
    debouncedMasterSync: { flush: mocks.flush },
    syncHyperciteWithNodeImmediately: mocks.syncHyperciteWithNodeImmediately,
  };
});
vi.mock('../../../resources/js/indexedDB/hydration/rebuild', () => ({
  getNodesByDataNodeIDs: mocks.getNodesByDataNodeIDs,
  rebuildNodeArrays: mocks.rebuildNodeArrays,
}));
vi.mock('../../../resources/js/indexedDB/footnotes/index', () => ({
  getAllFootnotesForBook: vi.fn(async () => []),
}));
vi.mock('../../../resources/js/hyperlitContainer/utilities/activeContext', () => ({
  getActiveBook: () => 'bookb',
}));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({
  broadcastToOpenTabs: mocks.broadcastToOpenTabs,
}));
vi.mock('../../../resources/js/divEditor/editorState', () => ({
  queueNodeForSave: mocks.queueNodeForSave,
}));

import { initHypercitesDependencies, updateCitationForExistingHypercite } from '../../../resources/js/indexedDB/hypercites/index';
import { getNodesFromIndexedDB } from '../../../resources/js/indexedDB/nodes/read';
import { reconcileCitedINForCitingBook } from '../../../resources/js/hypercites/reconciliation';
import { collectAbsenceCandidates, reconcileAbsences } from '../../../resources/js/indexedDB/nodes/absenceReconciler';

const STALE_BOOKB_CONTENT =
  '<p id="200" data-node-id="dn_b1">text ‘quote’<a id="hypercite_old" href="/booka#hypercite_src" class="open-icon">↗</a> tail</p>';

async function seedWorld() {
  await seedStore('hypercites', [{
    book: 'booka',
    hyperciteId: 'hypercite_src',
    relationshipStatus: 'couple',
    node_id: ['dn_src'],
    charData: { dn_src: { charStart: 5, charEnd: 15 } },
    citedIN: ['/bookb#hypercite_old'],
    hypercitedText: 'cited text',
  }]);
  await seedStore('nodes', [
    // Source book node — cached, so resolveHypercite accepts the local record.
    { book: 'booka', startLine: 100, node_id: 'dn_src', content: '<p id="100" data-node-id="dn_src">x <u id="hypercite_src" class="couple">cited text</u> y</p>' },
    // Citing book node — STALE content still holding the cut anchor.
    { book: 'bookb', startLine: 200, node_id: 'dn_b1', content: STALE_BOOKB_CONTENT },
  ]);
}

beforeEach(async () => {
  installFreshIndexedDB();
  vi.clearAllMocks();
  document.body.innerHTML = '';
  initHypercitesDependencies({
    updateBookTimestamp: mocks.updateBookTimestamp,
    queueForSync: mocks.queueForSync,
    withPending: (fn) => fn(),
    getNodesFromIndexedDB,
  });
  await seedWorld();
});

// The rendered bookb node AFTER the cut: anchor gone, (optionally) new anchor pasted.
function renderBookbNode(inner) {
  document.body.innerHTML =
    `<div class="main-content" data-book-id="bookb"><div class="chunk"><p id="200" data-node-id="dn_b1">${inner}</p></div></div>`;
  return document.getElementById('200');
}

describe('cut → repaste leaves exactly ONE citedIN entry', () => {
  it('paste-side reconciliation prunes the dead entry before the fresh append (the reported bug)', async () => {
    renderBookbNode('text ‘quote’<a id="hypercite_new" href="/booka#hypercite_src" class="open-icon">↗</a> tail');

    // What handleHypercitePaste now does for each pasted citation:
    await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb');
    const result = await updateCitationForExistingHypercite('booka', 'hypercite_src', '/bookb#hypercite_new');

    expect(result.success).toBe(true);
    const record = await readOne('hypercites', ['booka', 'hypercite_src']);
    expect(record.citedIN).toEqual(['/bookb#hypercite_new']);
    expect(record.relationshipStatus).toBe('couple');
  });

  it('save-time absence reconciliation alone heals a cut whose delink was lost (no re-paste)', async () => {
    const liveNode = renderBookbNode('text tail — anchor cut away');

    const candidate = collectAbsenceCandidates(STALE_BOOKB_CONTENT, liveNode, 'bookb', '200');
    expect(candidate).not.toBeNull();
    expect(candidate.missingAnchors).toEqual([{ elementId: 'hypercite_old', href: '/booka#hypercite_src' }]);

    await reconcileAbsences([candidate]);

    const record = await readOne('hypercites', ['booka', 'hypercite_src']);
    expect(record.citedIN).toEqual([]);
    expect(record.relationshipStatus).toBe('single');
  });

  it('the two layers compose idempotently: save-time delink THEN paste append still yields one entry', async () => {
    const liveNode = renderBookbNode('text ‘quote’<a id="hypercite_new" href="/booka#hypercite_src" class="open-icon">↗</a> tail');

    // Save-time reconciler fires first (cut healed at the save seam)…
    const candidate = collectAbsenceCandidates(STALE_BOOKB_CONTENT, liveNode, 'bookb', '200');
    await reconcileAbsences([candidate]);
    // …then the paste path runs its own reconcile + append.
    await reconcileCitedINForCitingBook('booka', 'hypercite_src', 'bookb');
    await updateCitationForExistingHypercite('booka', 'hypercite_src', '/bookb#hypercite_new');

    const record = await readOne('hypercites', ['booka', 'hypercite_src']);
    expect(record.citedIN).toEqual(['/bookb#hypercite_new']);
    expect(record.relationshipStatus).toBe('couple');
  });
});
