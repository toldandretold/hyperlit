/**
 * Save-time hypercite absence reconciliation
 * (resources/js/indexedDB/nodes/absenceReconciler.ts): diffing a saved node's
 * previous content against its live element, and repairing records whose
 * <u>/<a> vanished without a (surviving) mutation event — the dropped-batch /
 * muted-observer bug class behind "two citations, one red".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getHyperciteFromIndexedDB: vi.fn(),
  getNodesByDataNodeIDs: vi.fn(async () => []),
  updateHyperciteInIndexedDB: vi.fn(async () => true),
  delinkHypercite: vi.fn(async () => {}),
  queueNodeForSave: vi.fn(),
  state: { inFlight: false },
}));

vi.mock('../../../resources/js/indexedDB/hypercites/read', () => ({
  getHyperciteFromIndexedDB: mocks.getHyperciteFromIndexedDB,
}));
vi.mock('../../../resources/js/indexedDB/hydration/rebuild', () => ({
  getNodesByDataNodeIDs: mocks.getNodesByDataNodeIDs,
}));
vi.mock('../../../resources/js/indexedDB/hypercites/index', () => ({
  updateHyperciteInIndexedDB: mocks.updateHyperciteInIndexedDB,
}));
vi.mock('../../../resources/js/hypercites/deletion', () => ({
  delinkHypercite: mocks.delinkHypercite,
}));
vi.mock('../../../resources/js/divEditor/editorState', () => ({
  queueNodeForSave: mocks.queueNodeForSave,
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  isPasteInProgress: () => mocks.state.inFlight,
  isProgrammaticUpdateInProgress: () => false,
  getHandleHypercitePaste: () => false,
}));

import {
  collectAbsenceCandidates,
  reconcileAbsences,
} from '../../../resources/js/indexedDB/nodes/absenceReconciler';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  mocks.state.inFlight = false;
  mocks.updateHyperciteInIndexedDB.mockResolvedValue(true);
  mocks.getNodesByDataNodeIDs.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

const OLD_WITH_ANCHOR =
  '<p>text ‘q’<a id="hypercite_c1" href="/booka#hypercite_src" class="open-icon">↗</a> tail</p>';
const OLD_WITH_U =
  '<p>text <u id="hypercite_s1" class="couple">cited</u> tail</p>';

function liveNode(html, { id = '200', dataNodeId = 'dn1' } = {}) {
  const el = document.createElement('p');
  el.id = id;
  el.setAttribute('data-node-id', dataNodeId);
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe('collectAbsenceCandidates', () => {
  it('flags an anchor present in old content but gone from the live node and document', () => {
    const node = liveNode('text tail');
    const candidate = collectAbsenceCandidates(OLD_WITH_ANCHOR, node, 'bookb', '200');
    expect(candidate).toEqual({
      bookId: 'bookb',
      lineId: '200',
      dataNodeID: 'dn1',
      missingSourceUs: [],
      missingAnchors: [{ elementId: 'hypercite_c1', href: '/booka#hypercite_src' }],
    });
  });

  it('flags a source <u> gone from the live node and document', () => {
    const node = liveNode('text tail');
    const candidate = collectAbsenceCandidates(OLD_WITH_U, node, 'booka', '100');
    expect(candidate.missingSourceUs).toEqual(['hypercite_s1']);
  });

  it('excludes an id that still exists ELSEWHERE in the document (moved, not deleted)', () => {
    document.body.innerHTML = '<p id="300"><a id="hypercite_c1" href="/booka#hypercite_src">↗</a></p>';
    const node = liveNode('text tail');
    expect(collectAbsenceCandidates(OLD_WITH_ANCHOR, node, 'bookb', '200')).toBeNull();
  });

  it('returns null when the element is still in the live node, when old content has no hypercites, or no old content', () => {
    const node = liveNode('x <a id="hypercite_c1" href="/booka#hypercite_src">↗</a>');
    expect(collectAbsenceCandidates(OLD_WITH_ANCHOR, node, 'bookb', '200')).toBeNull();
    expect(collectAbsenceCandidates('<p>plain</p>', node, 'bookb', '200')).toBeNull();
    expect(collectAbsenceCandidates(null, node, 'bookb', '200')).toBeNull();
  });
});

describe('reconcileAbsences — missing citing anchors', () => {
  it('delinks a lost anchor', async () => {
    await reconcileAbsences([{
      bookId: 'bookb', lineId: '200', dataNodeID: 'dn1',
      missingSourceUs: [],
      missingAnchors: [{ elementId: 'hypercite_c1', href: '/booka#hypercite_src' }],
    }]);

    expect(mocks.delinkHypercite).toHaveBeenCalledWith('hypercite_c1', '/booka#hypercite_src');
  });

  it('skips an anchor that reappeared by execution time', async () => {
    document.body.innerHTML = '<p><a id="hypercite_c1" href="/booka#hypercite_src">↗</a></p>';

    await reconcileAbsences([{
      bookId: 'bookb', lineId: '200', dataNodeID: 'dn1',
      missingSourceUs: [],
      missingAnchors: [{ elementId: 'hypercite_c1', href: '/booka#hypercite_src' }],
    }]);

    expect(mocks.delinkHypercite).not.toHaveBeenCalled();
  });
});

describe('reconcileAbsences — missing source <u>', () => {
  const candidate = (over = {}) => ({
    bookId: 'booka', lineId: '100', dataNodeID: 'dn1',
    missingSourceUs: ['hypercite_s1'], missingAnchors: [], ...over,
  });

  it('sole host + CITED → ghost record (charData -1/-1, ghost anchor) + DOM tombstone + node re-queued', async () => {
    document.body.innerHTML = '<div class="chunk"><p id="100" data-node-id="dn1">rest of paragraph</p></div>';
    mocks.getHyperciteFromIndexedDB.mockResolvedValue({
      book: 'booka', hyperciteId: 'hypercite_s1', relationshipStatus: 'couple',
      node_id: ['dn1'], charData: { dn1: { charStart: 5, charEnd: 10 } },
      citedIN: ['/bookb#hypercite_c1'],
    });

    await reconcileAbsences([candidate()]);

    expect(mocks.updateHyperciteInIndexedDB).toHaveBeenCalledWith('booka', 'hypercite_s1', {
      relationshipStatus: 'ghost',
      charData: { dn1: { charStart: -1, charEnd: -1 } },
      _ghost_anchor_node: 'dn1',
    });
    const tombstone = document.getElementById('hypercite_s1');
    expect(tombstone.classList.contains('hypercite-tombstone')).toBe(true);
    expect(tombstone.parentElement.id).toBe('100');
    expect(mocks.queueNodeForSave).toHaveBeenCalledWith('100', 'update');
  });

  it('hosted by another UN-rendered node → partial prune only, NO ghost', async () => {
    mocks.getHyperciteFromIndexedDB.mockResolvedValue({
      book: 'booka', hyperciteId: 'hypercite_s1', relationshipStatus: 'couple',
      node_id: ['dn1', 'dn2'], charData: { dn1: { charStart: 5, charEnd: 10 }, dn2: { charStart: 0, charEnd: 4 } },
      citedIN: ['/bookb#hypercite_c1'],
    });
    mocks.getNodesByDataNodeIDs.mockResolvedValue([
      { book: 'booka', node_id: 'dn2', content: '<p>also has <u id="hypercite_s1">cited</u></p>' },
    ]);

    await reconcileAbsences([candidate()]);

    expect(mocks.updateHyperciteInIndexedDB).toHaveBeenCalledWith('booka', 'hypercite_s1', {
      node_id: ['dn2'],
      charData: { dn2: { charStart: 0, charEnd: 4 } },
    });
    expect(document.getElementById('hypercite_s1')).toBeNull();
  });

  it('sole host + UNCITED → node bookkeeping pruned and record orphaned (recoverable)', async () => {
    mocks.getHyperciteFromIndexedDB.mockResolvedValue({
      book: 'booka', hyperciteId: 'hypercite_s1', relationshipStatus: 'single',
      node_id: ['dn1'], charData: { dn1: { charStart: 5, charEnd: 10 } },
      citedIN: [],
    });

    await reconcileAbsences([candidate()]);

    const [, , fields] = mocks.updateHyperciteInIndexedDB.mock.calls[0];
    expect(fields.node_id).toEqual([]);
    expect(fields.charData).toEqual({});
    expect(typeof fields._orphaned_at).toBe('number');
    expect(document.getElementById('hypercite_s1')).toBeNull();
  });

  it('does nothing when the record no longer exists or the id reappeared', async () => {
    mocks.getHyperciteFromIndexedDB.mockResolvedValue(undefined);
    await reconcileAbsences([candidate()]);
    expect(mocks.updateHyperciteInIndexedDB).not.toHaveBeenCalled();

    document.body.innerHTML = '<p><u id="hypercite_s1">restored</u></p>';
    await reconcileAbsences([candidate()]);
    expect(mocks.getHyperciteFromIndexedDB).toHaveBeenCalledTimes(1); // second call short-circuits on the DOM check
  });
});

describe('reconcileAbsences — in-flight operation deferral (real timers: the retry path awaits a dynamic import)', () => {
  const candidates = [{
    bookId: 'bookb', lineId: '200', dataNodeID: 'dn1',
    missingSourceUs: [],
    missingAnchors: [{ elementId: 'hypercite_c1', href: '/booka#hypercite_src' }],
  }];

  it('defers while a paste is in flight and runs once it clears', async () => {
    mocks.state.inFlight = true;

    await reconcileAbsences(candidates);
    expect(mocks.delinkHypercite).not.toHaveBeenCalled();

    mocks.state.inFlight = false;
    await new Promise((r) => setTimeout(r, 400)); // > RETRY_DELAY_MS

    expect(mocks.delinkHypercite).toHaveBeenCalledWith('hypercite_c1', '/booka#hypercite_src');
  });

  it('gives up after one retry when the operation never clears (the next save re-collects)', async () => {
    mocks.state.inFlight = true;

    await reconcileAbsences(candidates);
    await new Promise((r) => setTimeout(r, 500));

    expect(mocks.delinkHypercite).not.toHaveBeenCalled();
    mocks.state.inFlight = false;
    await new Promise((r) => setTimeout(r, 250)); // drain any stray retry before the next test
  });
});
