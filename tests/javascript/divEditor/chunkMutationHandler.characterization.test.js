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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  getNodesFromIndexedDB: vi.fn(() => Promise.resolve([])),
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
// Same mocked objects the handler reads — let tests drive the per-chunk count + assert the split.
import { handleChunkOverflow as mockHandleChunkOverflow, chunkNodeCounts as mockCounts } from '../../../resources/js/divEditor/chunkManager';

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

// A chunk-overflow MOVE removes the node from its old chunk and re-attaches the SAME object
// in another chunk. The MutationObserver delivers that removal asynchronously — possibly
// after handleChunkOverflow's finally has torn down movedNodesByOverflow / the overflow flag
// — so a move could be misread as a user delete (spurious server delete → integrity
// self-heal round-trip). A moved node is still .isConnected; a deleted one is detached.
describe('processChunkMutations — move vs delete (isConnected guard)', () => {
  it('does NOT queue a deletion for a removed node that is still connected (moved)', async () => {
    const chunk = makeChunk('');
    // Simulate the move: the "removed from old chunk" node is now re-attached elsewhere in
    // the live DOM, so node.isConnected === true at observer-process time.
    const movedP = document.createElement('p'); movedP.id = '60000'; movedP.textContent = 'moved';
    const otherChunk = document.createElement('div');
    otherChunk.className = 'chunk';
    otherChunk.setAttribute('data-chunk-id', 'c2');
    chunk.parentElement.appendChild(otherChunk);
    otherChunk.appendChild(movedP); // re-attached → connected

    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [movedP] })], 'bookA');

    expect(saveQueue.queueDeletion).not.toHaveBeenCalled();
    expect(handler.removedNodeIds.has('60000')).toBe(false);
  });

  it('still queues a deletion for a removed node that is detached (real delete)', async () => {
    const chunk = makeChunk('');
    const delP = document.createElement('p'); delP.id = '7'; delP.textContent = 'gone';
    // never attached anywhere → isConnected === false
    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [delP] })], 'bookA');
    expect(saveQueue.queueDeletion).toHaveBeenCalledWith('7', delP, 'bookA');
    expect(handler.removedNodeIds.has('7')).toBe(true);
  });
});

// Rapid Enter in a FULL chunk used to split on every keystroke (disable contenteditable → move
// tail node → re-enable). Now a soft over-limit is DEBOUNCED — let the chunk grow while typing,
// rebalance once on pause — with a hard ceiling backstop and a flush at persist boundaries.
describe('processChunkMutations — debounced rebalance + hard ceiling', () => {
  // NODE_LIMIT=100, OVERFLOW_SLACK=25 → ceiling 125 (mirrors the production constants).
  const overLimitAdd = (chunk, count) => {
    mockCounts['c1'] = count;                       // trackChunkNodeCount is a no-op mock → count sticks
    const added = document.createElement('p'); added.id = '999'; added.textContent = 'new';
    chunk.appendChild(added);
    return childList(chunk, { added: [added] });
  };

  afterEach(() => { delete mockCounts['c1']; });

  it('DEFERS the split when softly over the limit (does not call handleChunkOverflow immediately)', async () => {
    const chunk = makeChunk('');
    await handler.processChunkMutations(chunk, [overLimitAdd(chunk, 103)], 'bookA');
    expect(mockHandleChunkOverflow).not.toHaveBeenCalled();   // deferred, not split synchronously
    expect(handler.rebalanceDebounceTimer).not.toBeNull();    // a debounce was armed
    expect(queueNodeForSave).toHaveBeenCalledWith('999', 'add'); // the new node is still queued
    handler.cancelRebalanceDebounce();
  });

  it('SPLITS immediately at the hard ceiling (NODE_LIMIT + OVERFLOW_SLACK)', async () => {
    const chunk = makeChunk('');
    await handler.processChunkMutations(chunk, [overLimitAdd(chunk, 125)], 'bookA');
    expect(mockHandleChunkOverflow).toHaveBeenCalledTimes(1);
    expect(handler.rebalanceDebounceTimer).toBeNull();        // no pending debounce
  });

  it('the debounce hands off to scheduleOverflowSweep after OVERFLOW_DEBOUNCE_MS', async () => {
    vi.useFakeTimers();
    try {
      const sweepSpy = vi.spyOn(handler, 'scheduleOverflowSweep').mockImplementation(() => {});
      const chunk = makeChunk('');
      await handler.processChunkMutations(chunk, [overLimitAdd(chunk, 103)], 'bookA');
      expect(sweepSpy).not.toHaveBeenCalled();                 // not yet — still debouncing
      vi.advanceTimersByTime(600);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      expect(handler.rebalanceDebounceTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushRebalance() splits an over-limit chunk now (persist boundary)', async () => {
    // Build a chunk with 101 real numeric-id nodes so the real sweepChunkOverflow trips.
    let html = '';
    for (let i = 1; i <= 101; i++) html += `<p id="${i}">n${i}</p>`;
    makeChunk(html);
    await handler.flushRebalance();
    expect(mockHandleChunkOverflow).toHaveBeenCalledTimes(1);
    // sweep drives the no-mutations path
    expect(mockHandleChunkOverflow).toHaveBeenCalledWith(expect.anything(), null);
  });
});
