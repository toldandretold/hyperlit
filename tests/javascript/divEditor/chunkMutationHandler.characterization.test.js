/**
 * Characterization of ChunkMutationHandler — pins the cohesive helper methods
 * (chunk lookup, numeric-node collection, skip/filter predicates, SPAN destruction)
 * and the high-traffic processChunkMutations paths (characterData → update, added
 * node → add, SPAN → destroyed, numeric removal → queueDeletion) BEFORE .js → .ts.
 *
 * The class takes all deps via constructor options, so we drive it with fakes.
 * (The no-delete-id marker deletion scenarios are RETIRED — the last-node
 * invariant is a runtime check now; its reactive half, the book-empty
 * backstop, is pinned below.)
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
  asBookId: (id) => id,
  parseChunkId: (v) => parseFloat(v),
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
    expect(queueNodeForSave).toHaveBeenCalledWith('1', 'update', 'bookA');
    expect(handler.modifiedNodes.has('1')).toBe(true);
  });

  it('characterData with no numeric-id ancestor queues nothing', async () => {
    const chunk = makeChunk('<em>floating inline</em>');
    const text = chunk.querySelector('em').firstChild;
    await handler.processChunkMutations(chunk, [{ type: 'characterData', target: text, addedNodes: [], removedNodes: [] }], 'bookA');
    expect(queueNodeForSave).not.toHaveBeenCalled();
  });

  it('characterData dedupes to one queue call per node per batch (autocorrect burst)', async () => {
    const chunk = makeChunk('<p id="1">origianl</p><p id="2">second</p>');
    const [t1, t2] = [chunk.querySelectorAll('p')[0].firstChild, chunk.querySelectorAll('p')[1].firstChild];
    const cd = (target) => ({ type: 'characterData', target, addedNodes: [], removedNodes: [] });
    await handler.processChunkMutations(chunk, [cd(t1), cd(t1), cd(t1), cd(t2), cd(t2)], 'bookA');
    expect(queueNodeForSave).toHaveBeenCalledTimes(2);
    expect(queueNodeForSave).toHaveBeenCalledWith('1', 'update', 'bookA');
    expect(queueNodeForSave).toHaveBeenCalledWith('2', 'update', 'bookA');
  });

  it('added element node gets an id and is queued for add', async () => {
    const chunk = makeChunk('');
    const newP = document.createElement('p'); newP.textContent = 'new';
    await handler.processChunkMutations(chunk, [childList(chunk, { added: [newP] })], 'bookA');
    expect(newP.id).toBe('gen');                          // ensureNodeHasValidId assigned it
    expect(queueNodeForSave).toHaveBeenCalledWith('gen', 'add', 'bookA');
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

  it('numeric-id removal queues a deletion with the chunk bookId', async () => {
    const chunk = makeChunk('');
    const delP = document.createElement('p'); delP.id = '5'; delP.textContent = 'gone';
    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [delP] })], 'bookA');
    expect(saveQueue.queueDeletion).toHaveBeenCalledWith('5', delP, 'bookA');
    expect(handler.removedNodeIds.has('5')).toBe(true);
  });
});

// The reactive half of the last-node invariant: ANY removal pathway (selection
// deletion, execCommand delete, cut, type-over — not just guarded keydowns)
// that leaves the book with zero content nodes triggers the minimal-structure
// rebuild. Marker-free: the retired system only reacted when the removed node
// happened to carry no-delete-id, and its early `return` leaked sibling
// deletions in batch wipes.
describe('processChunkMutations — book-empty backstop', () => {
  it('rebuilds minimal structure when a removal leaves the book with zero content nodes', async () => {
    const chunk = makeChunk('');
    const delP = document.createElement('p'); delP.id = '5'; delP.textContent = 'last one';
    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [delP] })], 'bookA');
    expect(saveQueue.queueDeletion).toHaveBeenCalledWith('5', delP, 'bookA'); // deletion still queued
    expect(ensureMinimumStructure).toHaveBeenCalled();
  });

  it('does NOT rebuild while sibling content nodes remain', async () => {
    const chunk = makeChunk('<p id="1">still here</p>');
    const delP = document.createElement('p'); delP.id = '5'; delP.textContent = 'gone';
    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [delP] })], 'bookA');
    expect(saveQueue.queueDeletion).toHaveBeenCalledWith('5', delP, 'bookA');
    expect(ensureMinimumStructure).not.toHaveBeenCalled();
  });

  it('batch wipe: EVERY removed node is queued for deletion (no early-return leak) and the rebuild fires', async () => {
    const chunk = makeChunk('');
    const mk = (id) => { const p = document.createElement('p'); p.id = id; p.textContent = id; return p; };
    const [a, b, c] = [mk('1'), mk('2'), mk('3')];
    await handler.processChunkMutations(chunk, [childList(chunk, { removed: [a, b, c] })], 'bookA');
    expect(saveQueue.queueDeletion).toHaveBeenCalledTimes(3);
    expect(ensureMinimumStructure).toHaveBeenCalled();
  });
});

// A select-all wipe (Cmd+A + Backspace / type-over) removes the CHUNK WRAPPERS
// from the book root: the numeric-id nodes are buried inside the removed
// wrappers, so the per-chunk pipeline never sees a deletion. handleRootLevelWipe
// (routed from processByChunk's no-containing-chunk branch) queues those buried
// deletions and rebuilds — while window-TRIMMING (also root-level chunk
// removal, but content always remains rendered) must stay untouched.
describe('processByChunk — root-level wipe (select-all delete)', () => {
  beforeEach(() => { window.isEditing = true; });
  afterEach(() => { delete window.isEditing; });

  const detachedChunkWith = (...ids) => {
    const chunk = document.createElement('div');
    chunk.className = 'chunk';
    chunk.setAttribute('data-chunk-id', '0');
    for (const id of ids) {
      const p = document.createElement('p'); p.id = id; p.textContent = `node ${id}`;
      chunk.appendChild(p);
    }
    return chunk; // never attached → isConnected === false, like a real wipe
  };

  it('queues deletions for nodes buried in removed chunk wrappers and rebuilds', async () => {
    const mc = document.createElement('div');
    mc.className = 'main-content';
    mc.id = 'bookA';
    document.body.appendChild(mc); // book root left empty — the wipe aftermath
    const gone = detachedChunkWith('100', '200');

    await handler.processByChunk([childList(mc, { removed: [gone] })]);

    expect(saveQueue.queueDeletion).toHaveBeenCalledWith('100', expect.anything(), 'bookA');
    expect(saveQueue.queueDeletion).toHaveBeenCalledWith('200', expect.anything(), 'bookA');
    expect(ensureMinimumStructure).toHaveBeenCalled();
  });

  it('ignores root-level chunk removal while rendered content remains (window trim)', async () => {
    const mc = document.createElement('div');
    mc.className = 'main-content';
    mc.id = 'bookA';
    mc.innerHTML = '<div class="chunk" data-chunk-id="2"><p id="300">still rendered</p></div>';
    document.body.appendChild(mc);
    const trimmed = detachedChunkWith('100', '200');

    await handler.processByChunk([childList(mc, { removed: [trimmed] })]);

    expect(saveQueue.queueDeletion).not.toHaveBeenCalled();
    expect(ensureMinimumStructure).not.toHaveBeenCalled();
  });

  it('ignores root-level removals outside edit mode (read-mode virtualization)', async () => {
    window.isEditing = false;
    const mc = document.createElement('div');
    mc.className = 'main-content';
    mc.id = 'bookA';
    document.body.appendChild(mc);
    const gone = detachedChunkWith('100');

    await handler.processByChunk([childList(mc, { removed: [gone] })]);

    expect(saveQueue.queueDeletion).not.toHaveBeenCalled();
    expect(ensureMinimumStructure).not.toHaveBeenCalled();
  });
});

// A chunk-overflow MOVE removes the node from its old chunk and re-attaches the SAME object
// in another chunk. The MutationObserver delivers that removal asynchronously — possibly
// after handleChunkOverflow's finally has torn down movedNodesByOverflow / the overflow flag
// — so a move could be misread as a user delete (spurious server delete → integrity
// self-heal round-trip). A moved node is still .isConnected; a deleted one is detached.
// characterData mutations carry a TEXT target, and Text nodes have no .closest() —
// processByChunk resolves the sub-book container off the target, so it must normalize
// to the parent Element first (resolving the containing chunk already does). Without
// that normalization the first autocorrect would TypeError and drop the whole RAF batch.
describe('processByChunk — Text-target mutations (characterData)', () => {
  const charData = (target) => ({ type: 'characterData', target, addedNodes: [], removedNodes: [] });

  it('main-book: text-target characterData reaches the queue via the text→element normalization', async () => {
    const chunk = makeChunk('<p id="3">hello</p>');
    await handler.processByChunk([charData(chunk.querySelector('p').firstChild)]);
    expect(queueNodeForSave).toHaveBeenCalledWith('3', 'update', 'latest'); // no main-content id in fixture → 'latest'
  });

  it('sub-book: text-target characterData resolves the sub-book container (no crash on .closest)', async () => {
    const sub = document.createElement('div');
    sub.className = 'sub-book-content';
    sub.dataset.bookId = 'book_sub';
    const chunk = document.createElement('div');
    chunk.className = 'chunk';
    chunk.setAttribute('data-chunk-id', '0');
    chunk.innerHTML = '<p id="7">sub text</p>';
    sub.appendChild(chunk);
    document.body.appendChild(sub);

    await handler.processByChunk([charData(chunk.querySelector('p').firstChild)]);
    expect(queueNodeForSave).toHaveBeenCalledWith('7', 'update', 'book_sub'); // attributed to the SUB-BOOK, not the active queue

    sub.remove();
  });
});

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
    expect(queueNodeForSave).toHaveBeenCalledWith('999', 'add', 'bookA'); // the new node is still queued
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
