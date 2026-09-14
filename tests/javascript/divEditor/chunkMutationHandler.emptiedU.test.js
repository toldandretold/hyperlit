/**
 * The emptied-<u> hypercite branch of ChunkMutationHandler.processChunkMutations
 * (chunkMutationHandler/index.ts): when a deletion leaves an EMPTY hypercite <u>
 * still attached (the browser keeps the wrapper, so domUtilities CHECK 2 never
 * fires), the handler must convert it to a tombstone in place when the record is
 * cited, or drop it when it isn't. Previously untested.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { NUMERICAL_ID_PATTERN } = vi.hoisted(() => ({ NUMERICAL_ID_PATTERN: /^\d+(\.\d+)?$/ }));

vi.mock('../../../resources/js/utilities/operationState', () => ({
  chunkOverflowInProgress: false,
  userDeletionInProgress: false,
  isProgrammaticUpdateInProgress: () => false,
  isPasteInProgress: () => false,
}));
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  isNumericalId: (id) => !!id && NUMERICAL_ID_PATTERN.test(id),
  ensureNodeHasValidId: (el) => { if (!el.id) el.id = 'gen'; },
  asBookId: (id) => id,
  parseChunkId: (v) => parseFloat(v),
  NUMERICAL_ID_PATTERN,
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
}));
vi.mock('../../../resources/js/paste/pasteState', () => ({ isPasteOperationActive: () => false }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  verbose: { content: vi.fn() },
  log: { error: vi.fn() },
}));
vi.mock('../../../resources/js/lazyLoader/utilities/chunkLoadingState', () => ({ setChunkLoadingInProgress: vi.fn() }));
vi.mock('../../../resources/js/hypercites/database.js', () => ({ getHyperciteById: vi.fn() }));
vi.mock('../../../resources/js/hypercites/deletion', () => ({ markHyperciteAsGhost: vi.fn(async () => true) }));

import { ChunkMutationHandler } from '../../../resources/js/divEditor/chunkMutationHandler/index';
import { getHyperciteById } from '../../../resources/js/hypercites/database.js';
import { markHyperciteAsGhost } from '../../../resources/js/hypercites/deletion';

let queueNodeForSave, handler;
beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  queueNodeForSave = vi.fn();
  handler = new ChunkMutationHandler({
    observedChunks: new Map(),
    saveQueue: { queueDeletion: vi.fn() },
    queueNodeForSave,
    handleHyperciteRemoval: vi.fn(() => Promise.resolve()),
    ensureMinimumStructure: vi.fn(),
    removedNodeIds: new Set(),
    addedNodes: new Set(),
    modifiedNodes: new Set(),
    documentChanged: { value: false },
  });
});

function makeChunkWithEmptyU(uAttrs = 'id="hypercite_x1" class="couple"') {
  const mc = document.createElement('div');
  mc.className = 'main-content';
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  chunk.setAttribute('data-chunk-id', 'c1');
  chunk.innerHTML = `<p id="100">before <u ${uAttrs}></u> after</p>`;
  mc.appendChild(chunk);
  document.body.appendChild(mc);
  return { chunk, u: chunk.querySelector('u') };
}

const emptiedUMutation = (u) =>
  ({ type: 'childList', target: u, addedNodes: [], removedNodes: [document.createTextNode('cut text')] });

describe('emptied hypercite <u> → tombstone in place', () => {
  it('converts a CITED emptied <u> to a tombstone, marks the record ghost, and queues the parent', async () => {
    const { chunk, u } = makeChunkWithEmptyU();
    getHyperciteById.mockResolvedValue({ book: 'bookA', hyperciteId: 'hypercite_x1', citedIN: ['/bookb#hypercite_c1'] });

    await handler.processChunkMutations(chunk, [emptiedUMutation(u)], 'bookA');

    expect(u.isConnected).toBe(true);
    expect(u.className).toBe('hypercite-tombstone');
    expect(u.getAttribute('data-ghost')).toBe('true');
    expect(markHyperciteAsGhost).toHaveBeenCalledWith('hypercite_x1');
    expect(queueNodeForSave).toHaveBeenCalledWith('100', 'update', 'bookA');
  });

  it('REMOVES an uncited emptied <u> and does not ghost it', async () => {
    const { chunk, u } = makeChunkWithEmptyU();
    getHyperciteById.mockResolvedValue({ book: 'bookA', hyperciteId: 'hypercite_x1', citedIN: [] });

    await handler.processChunkMutations(chunk, [emptiedUMutation(u)], 'bookA');

    expect(document.getElementById('hypercite_x1')).toBeNull();
    expect(markHyperciteAsGhost).not.toHaveBeenCalled();
  });

  it('removes the emptied <u> when no record exists at all', async () => {
    const { chunk, u } = makeChunkWithEmptyU();
    getHyperciteById.mockResolvedValue(undefined);

    await handler.processChunkMutations(chunk, [emptiedUMutation(u)], 'bookA');

    expect(document.getElementById('hypercite_x1')).toBeNull();
    expect(markHyperciteAsGhost).not.toHaveBeenCalled();
  });

  it('leaves an existing tombstone alone', async () => {
    const { chunk, u } = makeChunkWithEmptyU('id="hypercite_x1" class="hypercite-tombstone" data-ghost="true"');

    await handler.processChunkMutations(chunk, [emptiedUMutation(u)], 'bookA');

    expect(u.isConnected).toBe(true);
    expect(getHyperciteById).not.toHaveBeenCalled();
    expect(markHyperciteAsGhost).not.toHaveBeenCalled();
  });
});
