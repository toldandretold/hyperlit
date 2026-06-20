/**
 * Layer 1 (chunk-id creation): a real chunk overflow that must INSERT a chunk between two
 * adjacent integer chunks produces a DECIMAL `data-chunk-id` via fractional indexing — and
 * that decimal is what gets persisted to IndexedDB.
 *
 * Why this is a separate file from chunkOverflow.observer.test.js:
 *   - That sibling builds ONE chunk, so overflow hits the "no next chunk" branch
 *     (chunkManager.ts ~line 261) which yields an INTEGER id (currentId + 1). It therefore
 *     MOCKS `generateIdBetween` away — the fractional algorithm never runs, so a regression
 *     in the decimal math would pass unnoticed.
 *   - This file uses the REAL utilities/idHelpers (generateIdBetween + the asChunkId /
 *     parseChunkId BRAND helpers — otherwise never exercised by a test) and forces the
 *     "insert between full neighbours" branch (chunkManager.ts ~line 228), where the new
 *     chunk id = generateIdBetween('4','5') = a decimal strictly between 4 and 5.
 *
 * idHelpers is a zero-import leaf (only dep with weight is `book` from ../app, stubbed below),
 * so importing it for real is cheap and faithful.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installDecimalIdSelectorShim } from '../_helpers/decimalIdSelectorShim.js';

// Let the REAL idHelpers.isIdInUse() run under happy-dom (see the shim's header).
installDecimalIdSelectorShim();

// updateSingleIndexedDBRecord is the IDB sink handleChunkOverflow calls per moved node — spy on
// it to capture the chunk_id that actually gets persisted.
const { updateSingleIndexedDBRecord } = vi.hoisted(() => ({
  updateSingleIndexedDBRecord: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({ updateSingleIndexedDBRecord }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
vi.mock('../../../resources/js/utilities/operationState', () => ({ setChunkOverflowInProgress: vi.fn() }));
// Real idHelpers imports `book` from ../app (the eager entry root). Stub just that so the leaf
// loads without booting the app graph — everything else in idHelpers/types is used for real.
vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));

import {
  handleChunkOverflow,
  NODE_LIMIT,
  chunkNodeCounts,
} from '../../../resources/js/divEditor/chunkManager';
import { generateIdBetween } from '../../../resources/js/utilities/idHelpers';

const byId = (id) => document.getElementById(String(id));

/**
 * Build a document with TWO adjacent integer chunks (data-chunk-id "4" and "5"). Chunk 4 is
 * filled to NODE_LIMIT+1 (overflowing); chunk 5 is marked FULL via chunkNodeCounts so the
 * overflow node cannot be absorbed into it — forcing creation of a fractional chunk between them.
 */
function buildTwoAdjacentChunks() {
  document.body.innerHTML = '';
  const main = document.createElement('div');
  main.className = 'main-content';

  const chunk4 = document.createElement('div');
  chunk4.className = 'chunk';
  chunk4.setAttribute('data-chunk-id', '4');
  for (let i = 1; i <= NODE_LIMIT + 1; i++) {
    const p = document.createElement('p');
    p.id = String(i);
    p.textContent = `node ${i}`;
    chunk4.appendChild(p);
  }

  const chunk5 = document.createElement('div');
  chunk5.className = 'chunk';
  chunk5.setAttribute('data-chunk-id', '5');
  for (let i = 1; i <= 3; i++) {
    const p = document.createElement('p');
    p.id = String(200 + i);
    p.textContent = `node ${200 + i}`;
    chunk5.appendChild(p);
  }

  main.appendChild(chunk4);
  main.appendChild(chunk5);
  document.body.appendChild(main);

  // Mark chunk 5 as already at the limit so the overflow node can't be merged into it.
  chunkNodeCounts['5'] = NODE_LIMIT;
  return { main, chunk4, chunk5 };
}

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
  document.body.innerHTML = '';
});

describe('handleChunkOverflow — fractional chunk id between two adjacent integers', () => {
  it('sanity: the real generator yields a decimal strictly between 4 and 5', () => {
    const id = generateIdBetween('4', '5');
    expect(id).toBe('4.1');           // CASE 3 (idHelpers.ts) for adjacent integers
    expect(parseFloat(id)).toBeGreaterThan(4);
    expect(parseFloat(id)).toBeLessThan(5);
  });

  it('inserts a new .chunk with a DECIMAL data-chunk-id between chunks 4 and 5', async () => {
    const { main, chunk4 } = buildTwoAdjacentChunks();
    caretIn(byId(1));

    const result = await handleChunkOverflow(chunk4, null);
    expect(result).toBe(true);

    // Three chunks now: 4, <new decimal>, 5 — in DOM order.
    const ids = Array.from(main.querySelectorAll('.chunk')).map(c => c.getAttribute('data-chunk-id'));
    expect(ids.length).toBe(3);
    expect(ids[0]).toBe('4');
    expect(ids[2]).toBe('5');

    const newId = ids[1];
    // The middle chunk's id is the REAL fractional-indexing output — a decimal between 4 and 5.
    expect(newId).toBe(generateIdBetween('4', '5'));
    expect(newId).toMatch(/\.\d/);
    expect(parseFloat(newId)).toBeGreaterThan(4);
    expect(parseFloat(newId)).toBeLessThan(5);

    // The overflow node left chunk 4 and landed in the new middle chunk.
    expect(chunk4.querySelector(`[id="${NODE_LIMIT + 1}"]`)).toBeNull();
    expect(main.querySelectorAll('.chunk')[1].querySelector(`[id="${NODE_LIMIT + 1}"]`)).not.toBeNull();
  });

  it('persists the moved node to IDB with the decimal chunk_id as a NUMBER (asChunkId/parseFloat, not parseInt)', async () => {
    const { chunk4 } = buildTwoAdjacentChunks();
    caretIn(byId(1));

    await handleChunkOverflow(chunk4, null);

    expect(updateSingleIndexedDBRecord).toHaveBeenCalled();
    const saved = updateSingleIndexedDBRecord.mock.calls.map(([arg]) => arg);
    // Every persisted overflow node carries the fractional chunk_id, as a number — NOT truncated to 4.
    for (const rec of saved) {
      expect(typeof rec.chunk_id).toBe('number');
      expect(rec.chunk_id).toBe(parseFloat(generateIdBetween('4', '5'))); // 4.1, not 4
    }
  });
});
