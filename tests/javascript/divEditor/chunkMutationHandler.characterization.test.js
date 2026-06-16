/**
 * Characterization of ChunkMutationHandler — pins the cohesive helper methods
 * (chunk lookup, numeric-node collection, skip/filter predicates, SPAN destruction)
 * and the high-traffic processChunkMutations paths (characterData → update, added
 * node → add, SPAN → destroyed, numeric removal → queueDeletion) BEFORE .js → .ts.
 *
 * The class takes all deps via constructor options, so we drive it with fakes.
 * The no-delete-id-marker deletion scenarios (getFirstNodeIdForBook + IDB transfer)
 * and chunk-overflow are async DOM/IDB orchestration → left to the e2e grand tour.
 *
 * Imported EXTENSIONLESS so this file runs against chunkMutationHandler.js now and
 * chunkMutationHandler/index.ts after the conversion — identical test, both sides.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { NUMERICAL_ID_PATTERN } = vi.hoisted(() => ({ NUMERICAL_ID_PATTERN: /^\d+(\.\d+)?$/ }));

vi.mock('../../../resources/js/utilities/operationState', () => ({
  chunkOverflowInProgress: false,
  userDeletionInProgress: false,
}));
// Pure ID helpers moved to utilities/idHelpers (chunkMutationHandler imports them from there now).
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  isNumericalId: (id) => !!id && NUMERICAL_ID_PATTERN.test(id),
  ensureNodeHasValidId: (el) => { if (!el.id) el.id = 'gen'; },
  NUMERICAL_ID_PATTERN,
}));
vi.mock('../../../resources/js/divEditor/editorState', () => ({ movedNodesByOverflow: new Set() }));
// chunkManager lives in divEditor/ — mock the real path so overflow is a no-op stub here.
// The REAL handleChunkOverflow + getCurrentChunk (incl. the "observer is not restarted on
// overflow" invariant) are exercised in the sibling chunkOverflow.observer.test.js.
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
  getNodeChunksFromIndexedDB: vi.fn(() => Promise.resolve([])),
  openDatabase: vi.fn(() => Promise.resolve({})),
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
import { destroySpan } from '../../../resources/js/divEditor/chunkMutationHandler/spanDestroyer';

let saveQueue, queueNodeForSave, handleHyperciteRemoval, ensureMinimumStructure, handler;
beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  saveQueue = { queueDeletion: vi.fn() };
  queueNodeForSave = vi.fn();
  handleHyperciteRemoval = vi.fn(() => Promise.resolve());
  ensureMinimumStructure = vi.fn();
  handler = new ChunkMutationHandler({
    observedChunks: new Map(),
    saveQueue,
    queueNodeForSave,
    handleHyperciteRemoval,
    ensureMinimumStructure,
    removedNodeIds: new Set(),
    addedNodes: new Set(),
    modifiedNodes: new Set(),
    documentChanged: { value: false },
  });
});

// Build a <div class="main-content"><div class="chunk" data-chunk-id="c1">…</div></div>
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

describe('findContainingChunk', () => {
  it('returns the .chunk ancestor (and caches it), null outside a chunk', () => {
    const chunk = makeChunk('<p id="1">hi</p>');
    const p = chunk.querySelector('p');
    expect(handler.findContainingChunk(p)).toBe(chunk);
    expect(handler.findContainingChunk(p.firstChild)).toBe(chunk);   // text node → parentElement
    const loose = document.createElement('p');
    document.body.appendChild(loose);
    expect(handler.findContainingChunk(loose)).toBeNull();
    expect(handler.findContainingChunk(null)).toBeNull();
  });
});

describe('isNodeWithinMainContent', () => {
  it('walks ancestors for .main-content', () => {
    const chunk = makeChunk('<p id="1">hi</p>');
    expect(handler.isNodeWithinMainContent(chunk.querySelector('p'))).toBe(true);
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    expect(handler.isNodeWithinMainContent(outside)).toBe(false);
  });
});

describe('findNumericalIdNodesInChunk', () => {
  it('collects only numeric-id elements', () => {
    const chunk = makeChunk('<p id="1">a</p><p id="2.3">b</p><p id="foo">c</p>');
    expect(handler.findNumericalIdNodesInChunk(chunk).map(n => n.id)).toEqual(['1', '2.3']);
  });
});

describe('isNumericalIdDeletion', () => {
  it('true only for a numeric-id element removed OUTSIDE a chunk but within main-content', () => {
    const mc = document.createElement('div'); mc.className = 'main-content';
    document.body.appendChild(mc);
    const removed = document.createElement('p'); removed.id = '7';
    expect(handler.isNumericalIdDeletion(removed, mc)).toBe(true);   // target=mc → not in a chunk, in main-content
    const chunk = makeChunk('<p id="9">x</p>');
    expect(handler.isNumericalIdDeletion(removed, chunk.querySelector('p'))).toBe(false); // target in a chunk
  });
});

describe('shouldSkipMutation', () => {
  it('skips status-icon mutations', () => {
    const icon = document.createElement('div'); icon.id = 'status-icon';
    expect(handler.shouldSkipMutation([{ target: icon, addedNodes: [] }])).toBe(true);
    const p = document.createElement('p'); p.id = '1';
    expect(handler.shouldSkipMutation([{ target: p, addedNodes: [] }])).toBe(false);
  });
});

describe('filterChunkMutations', () => {
  it('drops MARK-only mutations but keeps numeric-id removals', () => {
    const chunk = makeChunk('<p id="1">hi</p>');
    const p = chunk.querySelector('p');
    const mark = document.createElement('mark');
    const markOnly = childList(p, { added: [mark] });
    expect(handler.filterChunkMutations([markOnly])).toEqual([]);

    const delP = document.createElement('p'); delP.id = '2';
    const withDeletion = childList(p, { added: [mark], removed: [delP] });
    // numeric-id removal present → NOT skipped despite MARK
    expect(handler.filterChunkMutations([withDeletion])).toEqual([withDeletion]);
  });
});

describe('destroySpan', () => {
  it('replaces the span with a plain text node and removes it', () => {
    const chunk = makeChunk('<p id="1">a<span style="color:red">bold</span>b</p>');
    const span = chunk.querySelector('span');
    const { replacementNode } = destroySpan(span);
    expect(replacementNode).not.toBeNull();
    expect(chunk.querySelector('span')).toBeNull();
    expect(chunk.querySelector('p').textContent).toBe('aboldb');
  });
});

describe('processChunkMutations — high-traffic paths', () => {
  it('characterData change queues the numeric-id parent for update', async () => {
    const chunk = makeChunk('<p id="1">hello</p>');
    const text = chunk.querySelector('p').firstChild;
    await handler.processChunkMutations(chunk, [{ type: 'characterData', target: text, addedNodes: [], removedNodes: [] }], 'bookA');
    expect(queueNodeForSave).toHaveBeenCalledWith('1', 'update');
    expect(handler.modifiedNodes.has('1')).toBe(true);
  });

  it('added element node gets an id and is queued for add', async () => {
    const chunk = makeChunk('');
    const newP = document.createElement('p'); newP.textContent = 'new';
    await handler.processChunkMutations(chunk, [childList(chunk, { added: [newP] })], 'bookA');
    expect(newP.id).toBe('gen');                          // ensureNodeHasValidId assigned it
    expect(queueNodeForSave).toHaveBeenCalledWith('gen', 'add');
    expect(handler.documentChanged.value).toBe(true);
  });

  it('added SPAN is destroyed (no spans allowed)', async () => {
    const chunk = makeChunk('');
    const span = document.createElement('span'); span.textContent = 'x';
    chunk.appendChild(span);
    await handler.processChunkMutations(chunk, [childList(chunk, { added: [span] })], 'bookA');
    expect(chunk.querySelector('span')).toBeNull();
    expect(chunk.textContent).toContain('x');
  });

  it('numeric-id removal (no marker) queues a deletion with the chunk bookId', async () => {
    const chunk = makeChunk('');
    const delP = document.createElement('p'); delP.id = '5'; delP.textContent = 'gone';
    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [delP] })], 'bookA');
    expect(saveQueue.queueDeletion).toHaveBeenCalledWith('5', delP, 'bookA');
    expect(handler.removedNodeIds.has('5')).toBe(true);
  });
});
