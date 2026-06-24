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
  ensureNodeHasValidId,
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

/**
 * Regression guard for the phantom-`id="1"` paste bug: the MutationObserver path
 * (chunkMutationHandler → ensureNodeHasValidId) is a SECOND id-assigner, distinct from
 * setElementIds. Its no-id branch previously committed `generateIdBetween(null,null)` === "1"
 * with no duplicate post-check, so a freshly-inserted node with no numeric neighbours collided
 * with the genuine first node. The fix adds the same guard the has-id branch / setElementIds use.
 */
describe('ensureNodeHasValidId — no-id branch never commits a colliding id', () => {
  it('does NOT mint a second id="1" for a node with no numeric neighbours', () => {
    // Genuine first node lives in a chunk; the fresh node is isolated (no numeric
    // sibling in either direction, non-numeric parent) → both lookups return null.
    document.body.innerHTML = '';
    const chunk = document.createElement('div');
    chunk.className = 'chunk';
    chunk.setAttribute('data-chunk-id', '1');
    const first = document.createElement('p');
    first.id = '1';
    first.textContent = 'genuine first node';
    chunk.appendChild(first);
    document.body.appendChild(chunk);

    const iso = document.createElement('div'); // non-numeric wrapper, no numeric siblings
    const fresh = document.createElement('p');
    fresh.textContent = 'freshly pasted paragraph';
    iso.appendChild(fresh);
    document.body.appendChild(iso);

    ensureNodeHasValidId(fresh);

    expect(fresh.id).not.toBe('1');                          // no longer collides
    expect(NUMERICAL_ID_PATTERN.test(fresh.id)).toBe(true);  // still a valid positional id
    expect(fresh.id).toBe('1.1');                            // bumped under the same base
    expect(document.querySelectorAll('#1').length).toBe(1);  // genuine node 1 untouched
    expect(fresh.getAttribute('data-node-id')).toBeTruthy();
  });

  it('control: still assigns a between-value (no spurious bump) when neighbours have ids', () => {
    const chunk = buildAdjacentNodes(); // <p id="4">, <p id="5">
    const fresh = document.createElement('p');
    fresh.textContent = 'inserted between 4 and 5';
    chunk.insertBefore(fresh, chunk.querySelector('#5'));

    ensureNodeHasValidId(fresh);

    expect(parseFloat(fresh.id)).toBeGreaterThan(4);
    expect(parseFloat(fresh.id)).toBeLessThan(5);
    expect(document.querySelectorAll('#4').length).toBe(1);
    expect(document.querySelectorAll('#5').length).toBe(1);
  });
});
