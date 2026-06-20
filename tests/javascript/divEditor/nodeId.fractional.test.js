/**
 * Layer 1 (line-id creation): inserting a node BETWEEN two adjacent integer nodes mints a
 * DECIMAL `id=` (the LineId / startLine) via real fractional indexing, AND a stable non-numeric
 * `data-node-id` (the DataNodeId token) — both through the production `setElementIds`.
 *
 * This is the line-id twin of chunkOverflow.fractional.test.js: chunk ids and line ids share the
 * SAME `generateIdBetween` generator, but are minted at different call sites (chunkManager overflow
 * vs setElementIds, used by the Enter-key path in enterKeyHandler/caretHelpers.ts). We exercise the
 * REAL idHelpers (incl. the asLineId/asDataNodeId/parseChunkId brand helpers), stubbing only the
 * `book` global that idHelpers reads from ../app.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installDecimalIdSelectorShim } from '../_helpers/decimalIdSelectorShim.js';

// Let the REAL idHelpers (generateIdBetween/isIdInUse) run under happy-dom (see the shim header).
installDecimalIdSelectorShim();

vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));
vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));

import {
  setElementIds,
  generateIdBetween,
  isLineId,
  NUMERICAL_ID_PATTERN,
} from '../../../resources/js/utilities/idHelpers';

/** Two adjacent integer nodes in a chunk; the new node will be inserted between them. */
function buildAdjacentNodes() {
  document.body.innerHTML = '';
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  chunk.setAttribute('data-chunk-id', '1');
  for (const id of ['4', '5']) {
    const p = document.createElement('p');
    p.id = id;
    p.textContent = `node ${id}`;
    chunk.appendChild(p);
  }
  document.body.appendChild(chunk);
  return chunk;
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.__pendingRenumbering;
});

describe('setElementIds — decimal line id + stable data-node-id between adjacent integers', () => {
  it('mints a DECIMAL line id strictly between 4 and 5', () => {
    buildAdjacentNodes();
    const p = document.createElement('p');

    const id = setElementIds(p, '4', '5', 'bookA');

    expect(id).toBe(generateIdBetween('4', '5')); // '4.1'
    expect(p.id).toBe(id);
    expect(isLineId(id)).toBe(true);               // matches /^\d+(\.\d+)?$/
    expect(id).toMatch(/\.\d/);
    expect(parseFloat(id)).toBeGreaterThan(4);
    expect(parseFloat(id)).toBeLessThan(5);
  });

  it('also sets a NON-numeric data-node-id token shaped `${bookId}_...`', () => {
    buildAdjacentNodes();
    const p = document.createElement('p');

    setElementIds(p, '4', '5', 'bookA');

    const nodeId = p.getAttribute('data-node-id');
    expect(nodeId).toBeTruthy();
    expect(nodeId.startsWith('bookA_')).toBe(true);
    expect(NUMERICAL_ID_PATTERN.test(nodeId)).toBe(false); // a stable token, NOT a positional id
  });

  it('keeps the data-node-id STABLE across re-runs (only the positional id is regenerated)', () => {
    buildAdjacentNodes();
    const p = document.createElement('p');

    setElementIds(p, '4', '5', 'bookA');
    const firstNodeId = p.getAttribute('data-node-id');

    setElementIds(p, '4', '5', 'bookA'); // second pass: data-node-id already present
    expect(p.getAttribute('data-node-id')).toBe(firstNodeId);
  });
});
