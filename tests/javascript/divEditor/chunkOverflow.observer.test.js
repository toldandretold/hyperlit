/**
 * Regression: handleChunkOverflow must NOT tear down / restart the edit-mode observer.
 *
 * The observer is rooted at the editable CONTAINER (main-content / sub-book) with
 * subtree:true, so a newly-split chunk inserted into that container is already observed.
 * A previous version called stopObserving(); startObserving(targetChunk) after every
 * overflow, which re-pointed the single observer at one chunk and silently dropped edits
 * in every other chunk. This pins that the restart is gone while the node-move + IDB
 * persistence still happen.
 *
 * Also covers getCurrentChunk()'s honest `string | null` contract.
 *
 * Sibling: chunkMutationHandler.characterization.test.js mocks handleChunkOverflow away to
 * test the mutation handler in isolation; THIS file drives the real handleChunkOverflow.
 * (Opposite mock setups, so they must stay separate files — both run under `vitest run
 * tests/javascript/divEditor/`.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ONLY divEditor/index member handleChunkOverflow pulls in (dynamically) is
// movedNodesByOverflow. startObserving/stopObserving are spied so we can assert they're
// never invoked after the fix.
const { startObserving, stopObserving, movedNodesByOverflow } = vi.hoisted(() => ({
  startObserving: vi.fn(() => Promise.resolve()),
  stopObserving: vi.fn(() => Promise.resolve()),
  movedNodesByOverflow: new Set(),
}));
vi.mock('../../../resources/js/divEditor/index', () => ({
  startObserving,
  stopObserving,
  movedNodesByOverflow,
}));

const { updateSingleIndexedDBRecord } = vi.hoisted(() => ({
  updateSingleIndexedDBRecord: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({ updateSingleIndexedDBRecord }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
// IDfunctions statically imports ../pageLoad + ../app.js (whole app graph); operationState
// imports components/editIndicator. Stub the two members chunkManager actually uses so the
// test stays light and doesn't boot app.js.
// asChunkId/parseChunkId are pure brand helpers chunkManager uses on the chunk-id boundary;
// stub them faithfully (identity / parseFloat) so handleChunkOverflow's split path runs.
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  generateIdBetween: vi.fn(),
  asChunkId: (n) => n,
  parseChunkId: (s) => parseFloat(s),
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({ setChunkOverflowInProgress: vi.fn() }));

import {
  handleChunkOverflow,
  getCurrentChunk,
  NODE_LIMIT,
  chunkNodeCounts,
} from '../../../resources/js/divEditor/chunkManager';

function buildChunk(count) {
  document.body.innerHTML = '';
  const main = document.createElement('div');
  main.className = 'main-content';
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  chunk.setAttribute('data-chunk-id', '1');
  for (let i = 1; i <= count; i++) {
    const p = document.createElement('p');
    p.id = String(i);
    p.textContent = `node ${i}`;
    chunk.appendChild(p);
  }
  main.appendChild(chunk);
  document.body.appendChild(main);
  return { main, chunk };
}

// Numeric-leading ids (#1, #101) are invalid CSS selectors, so look them up by getElementById.
const byId = (id) => document.getElementById(String(id));

function caretIn(node) {
  const sel = document.getSelection();
  const range = document.createRange();
  range.setStart(node.firstChild || node, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(chunkNodeCounts)) delete chunkNodeCounts[k];
  movedNodesByOverflow.clear();
});

describe('handleChunkOverflow — observer is NOT restarted', () => {
  it('never calls stopObserving/startObserving when a chunk splits', async () => {
    const { chunk } = buildChunk(NODE_LIMIT + 1);
    caretIn(byId(NODE_LIMIT + 1)); // caret in the overflow node
    const result = await handleChunkOverflow(chunk, null);

    expect(result).toBe(true);                       // the move actually ran to completion
    expect(stopObserving).not.toHaveBeenCalled();
    expect(startObserving).not.toHaveBeenCalled();
  });

  it('still moves overflow nodes into a new chunk and persists them', async () => {
    const { main, chunk } = buildChunk(NODE_LIMIT + 1);
    caretIn(byId(50));
    await handleChunkOverflow(chunk, null);

    // A second chunk now exists, and the overflow node left the original chunk
    expect(main.querySelectorAll('.chunk').length).toBe(2);
    expect(chunk.querySelector(`[id="${NODE_LIMIT + 1}"]`)).toBeNull();
    // Each moved node was persisted to IDB
    expect(updateSingleIndexedDBRecord).toHaveBeenCalled();
    // The overflow-tracking set is cleared in the finally block
    expect(movedNodesByOverflow.size).toBe(0);
  });

  it('is a no-op (returns false) when the chunk is at/under the limit', async () => {
    const { chunk } = buildChunk(NODE_LIMIT);
    caretIn(byId(1));
    const result = await handleChunkOverflow(chunk, null);

    expect(result).toBe(false);
    expect(chunk.parentElement.querySelectorAll('.chunk').length).toBe(1);
    expect(stopObserving).not.toHaveBeenCalled();
    expect(startObserving).not.toHaveBeenCalled();
  });
});

describe('getCurrentChunk — honest string | null contract', () => {
  it('returns the chunk-id string when the caret is inside a .chunk', () => {
    buildChunk(3);
    caretIn(byId(2));
    expect(getCurrentChunk()).toBe('1'); // falls back to data-chunk-id (chunk has no id attr)
  });

  it('returns null when there is no selection', () => {
    buildChunk(3);
    document.getSelection().removeAllRanges();
    expect(getCurrentChunk()).toBeNull();
  });
});
