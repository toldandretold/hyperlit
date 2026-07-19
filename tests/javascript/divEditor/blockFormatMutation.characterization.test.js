/**
 * Pins the interaction between the blockquote/code format toggle
 * (editToolbar/blockFormat/blockquoteCodeFormat) and the real
 * ChunkMutationHandler: a p → blockquote → p toggle on a hypercite-bearing
 * node must classify as a same-id REPLACEMENT (single 'update'), never as a
 * delete + add — that misclassification (plus innerHTML re-parse cloning the
 * hypercite children) was the format-toggle duplication bug.
 *
 * Mock block cloned from chunkMutationHandler.characterization.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { NUMERICAL_ID_PATTERN } = vi.hoisted(() => ({ NUMERICAL_ID_PATTERN: /^\d+(\.\d+)?$/ }));

vi.mock('../../../resources/js/utilities/operationState', () => ({
  chunkOverflowInProgress: false,
  userDeletionInProgress: false,
}));
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  isNumericalId: (id) => !!id && NUMERICAL_ID_PATTERN.test(id),
  ensureNodeHasValidId: (el) => { if (!el.id) el.id = 'gen'; },
  NUMERICAL_ID_PATTERN,
  asLineId: (id) => id,
  setElementIds: vi.fn(),
  findPreviousElementId: vi.fn(),
  findNextElementId: vi.fn(),
}));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ movedNodesByOverflow: new Set() }));
vi.mock('../../../resources/js/divEditor/chunkManager', () => ({
  trackChunkNodeCount: vi.fn(),
  NODE_LIMIT: 100,
  chunkNodeCounts: {},
  handleChunkOverflow: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('../../../resources/js/components/tocContainer/index', () => ({
  checkAndInvalidateTocCache: vi.fn(),
  invalidateTocCacheForDeletion: vi.fn(),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  deleteIndexedDBRecordWithRetry: vi.fn(() => Promise.resolve()),
  updateSingleIndexedDBRecord: vi.fn(() => Promise.resolve()),
  getNodesFromIndexedDB: vi.fn(() => Promise.resolve([])),
  openDatabase: vi.fn(() => Promise.resolve({})),
  batchUpdateIndexedDBRecords: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../resources/js/paste', () => ({ isPasteOperationActive: () => false }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
vi.mock('../../../resources/js/lazyLoader/utilities/chunkLoadingState', () => ({ setChunkLoadingInProgress: vi.fn() }));
vi.mock('../../../resources/js/divEditor/domUtilities', () => ({
  getNoDeleteNode: vi.fn(),
  setNoDeleteMarker: vi.fn(),
  transferNoDeleteMarker: vi.fn(),
  findNextNoDeleteNode: vi.fn(),
}));

import { ChunkMutationHandler } from '../../../resources/js/divEditor/chunkMutationHandler/index';
import {
  _contentPreservingWrap,
  _contentPreservingUnwrap,
} from '../../../resources/js/editToolbar/blockFormat/blockquoteCodeFormat';

let saveQueue, queueNodeForSave, handleHyperciteRemoval, handler;
beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  saveQueue = { queueDeletion: vi.fn() };
  queueNodeForSave = vi.fn();
  handleHyperciteRemoval = vi.fn(() => Promise.resolve());
  handler = new ChunkMutationHandler({
    observedChunks: new Map(),
    saveQueue,
    queueNodeForSave,
    handleHyperciteRemoval,
    ensureMinimumStructure: vi.fn(),
    removedNodeIds: new Set(),
    addedNodes: new Set(),
    modifiedNodes: new Set(),
    documentChanged: { value: false },
  });
});

function makeChunk(innerHTML = '') {
  const mc = document.createElement('div');
  mc.className = 'main-content';
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  chunk.setAttribute('data-chunk-id', 'c1');
  chunk.innerHTML = innerHTML;
  mc.appendChild(chunk);
  document.body.appendChild(mc);
  return chunk;
}
const childList = (target, { added = [], removed = [] } = {}) =>
  ({ type: 'childList', target, addedNodes: added, removedNodes: removed });

const NODE_HTML =
  '<p id="42" data-node-id="n42"><u id="hypercite_x">cited</u> t <a href="#hypercite_x" class="open-icon">↗</a></p>';

describe('format toggle through the real mutation handler', () => {
  it('p → blockquote classifies as replacement: single update, no delete/add, no clones', async () => {
    const chunk = makeChunk(NODE_HTML);
    const p = chunk.querySelector('[id="42"]');

    const bq = _contentPreservingWrap(null, p, 'blockquote');
    // The move-based wrap empties the old <p> BEFORE the observer sees its
    // removal — the hypercite children were moved, so there is nothing for
    // handleHyperciteRemoval to scan (no delink/tombstone churn).
    expect(p.childNodes.length).toBe(0);

    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [p], added: [bq] })], 'bookA');

    expect(saveQueue.queueDeletion).not.toHaveBeenCalled();
    expect(queueNodeForSave).toHaveBeenCalledWith('42', 'update');
    expect(queueNodeForSave).not.toHaveBeenCalledWith(expect.anything(), 'add');
    expect(document.querySelectorAll('[id="42"]')).toHaveLength(1);
    expect(document.querySelectorAll('#hypercite_x')).toHaveLength(1);
    expect(document.getElementById('gen')).toBeNull(); // no node got a generated id
  });

  it('blockquote → p (the round-trip back) also classifies as replacement', async () => {
    const chunk = makeChunk(NODE_HTML);
    const bq = _contentPreservingWrap(null, chunk.querySelector('[id="42"]'), 'blockquote');
    vi.clearAllMocks();

    const p2 = _contentPreservingUnwrap(null, bq, 'blockquote');
    expect(bq.childNodes.length).toBe(0);

    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [bq], added: [p2] })], 'bookA');

    expect(saveQueue.queueDeletion).not.toHaveBeenCalled();
    expect(queueNodeForSave).toHaveBeenCalledWith('42', 'update');
    expect(queueNodeForSave).not.toHaveBeenCalledWith(expect.anything(), 'add');
    expect(document.querySelectorAll('[id="42"]')).toHaveLength(1);
    expect(document.querySelectorAll('#hypercite_x')).toHaveLength(1);
  });
});
