/**
 * Layer 2: a DECIMAL chunk_id (and decimal startLine, and the stable node_id) survives every
 * hop of the front-end write path — DOM → IndexedDB → on-the-wire sync payload — with the REAL
 * boundary functions (no mocked id helpers):
 *
 *   determineChunkIdFromDOM()   (indexedDB/nodes/contentProcessor.ts — the DOM→chunk_id seam
 *                                that batch.ts uses; parseChunkId = parseFloat, NOT parseInt)
 *   addNodeToIndexedDB()        (indexedDB/nodes/write — the real IDB persistence primitive)
 *   toPublicNode()              (indexedDB/core/utilities.ts — the real sync-payload builder
 *                                used by syncQueue/master)
 *
 * Composing the real seam functions (rather than booting the whole saveQueue orchestrator) keeps
 * the test deterministic while still exercising the production code at each hop. If any hop ever
 * regressed to parseInt / an integer cast, 4.5 would collapse to 4 and these assertions go red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFreshIndexedDB, readOne } from './idbHarness.js';
import { determineChunkIdFromDOM } from '../../../resources/js/indexedDB/nodes/contentProcessor';
import {
  addNodeToIndexedDB,
  initNodeWriteDependencies,
} from '../../../resources/js/indexedDB/nodes/write';
import { toPublicNode } from '../../../resources/js/indexedDB/core/utilities';

const NODE_ID = 'bookA_1700000000_abc';

/** A node with a decimal positional id, inside a chunk whose data-chunk-id is a decimal. */
function buildDecimalChunkDom() {
  document.body.innerHTML = '';
  const main = document.createElement('div');
  main.className = 'main-content';
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  chunk.setAttribute('data-chunk-id', '4.5'); // a fractional chunk (inserted between 4 and 5)
  const p = document.createElement('p');
  p.id = '4.5';                                // decimal LineId / startLine
  p.setAttribute('data-node-id', NODE_ID);     // stable DataNodeId token
  p.textContent = 'fractional node';
  chunk.appendChild(p);
  main.appendChild(chunk);
  document.body.appendChild(main);
  return p;
}

beforeEach(() => {
  installFreshIndexedDB();
  document.body.innerHTML = '';
  initNodeWriteDependencies({
    withPending: (fn) => fn(),
    book: 'bookA',
    updateBookTimestamp: vi.fn().mockResolvedValue(true),
    queueForSync: vi.fn(),
  });
});

describe('decimal chunk_id + startLine: DOM → IndexedDB → sync payload', () => {
  it('reads a DECIMAL chunk_id out of the DOM as a number (parseFloat, not parseInt)', () => {
    buildDecimalChunkDom();
    const chunkId = determineChunkIdFromDOM('4.5');
    expect(typeof chunkId).toBe('number');
    expect(chunkId).toBe(4.5); // NOT 4 — truncation would mean parseInt
  });

  it('persists chunk_id, startLine and node_id to IndexedDB without losing the decimals', async () => {
    const p = buildDecimalChunkDom();
    const chunkId = determineChunkIdFromDOM('4.5');

    await addNodeToIndexedDB('bookA', '4.5', p.outerHTML, chunkId, NODE_ID);

    const rec = await readOne('nodes', ['bookA', 4.5]);
    expect(rec).toBeTruthy();
    expect(rec.chunk_id).toBe(4.5);
    expect(rec.startLine).toBe(4.5);
    expect(rec.node_id).toBe(NODE_ID);
  });

  it('carries the decimals through to the on-the-wire PublicNode payload', async () => {
    const p = buildDecimalChunkDom();
    const chunkId = determineChunkIdFromDOM('4.5');
    await addNodeToIndexedDB('bookA', '4.5', p.outerHTML, chunkId, NODE_ID);
    const rec = await readOne('nodes', ['bookA', 4.5]);

    const pub = toPublicNode(rec);
    expect(pub.chunk_id).toBe(4.5);
    expect(pub.startLine).toBe(4.5);
    expect(pub.node_id).toBe(NODE_ID);

    // And it JSON-serialises without dropping precision (what actually goes over the wire).
    expect(JSON.parse(JSON.stringify(pub)).chunk_id).toBe(4.5);
  });
});
