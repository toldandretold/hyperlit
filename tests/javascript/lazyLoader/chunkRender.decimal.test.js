/**
 * Hop ⑥ of the decimal-chunkID lifecycle: the FRONTEND loader, fed the exact BACKEND read-back
 * shape (what DatabaseToIndexedDBController.getBookData now returns — distinct decimal chunk_ids),
 * regroups nodes into DISTINCT chunk divs. This proves a fractional chunk (4.5) and its integer
 * neighbour (4) never merge into one over-the-limit div — the failure mode the old `(int)`
 * truncation caused (both arrived as `4` → one merged chunk).
 *
 * Completes the lifecycle relay:
 *   ① birth (chunkOverflow.fractional / nodeId.fractional)
 *   ②③ DOM→IDB→payload (chunkId.roundtrip) + payload shape pinned (masterSync.characterization)
 *   ④⑤ payload→PG→readback distinct decimals (tests/Feature/Api/ChunkIdRoundTripTest.php)
 *   ⑥ readback→DOM regroup  ← THIS FILE  (+ chunkSelection.test.js = decimal-aware next/prev)
 * Playwright Layer 4 (chunk-overflow-paste.spec.js) is the real-browser belt-and-suspenders.
 */
import { describe, it, expect, vi } from 'vitest';

// createChunkElement renders each node's content; stub the render-only deps so this stays a pure
// grouping/stamping check (we assert the chunk WRAPPER's data-chunk-id, not inner markdown/katex).
vi.mock('../../../resources/js/utilities/convertMarkdown', () => ({
  renderBlockToHtml: (node) => `<p>${node.content ?? ''}</p>`,
}));
vi.mock('../../../resources/js/utilities/sanitizeConfig', () => ({ sanitizeHtml: (h) => h }));
vi.mock('../../../resources/js/lazyLoader/footnoteSelfHeal', () => ({ applyDynamicFootnoteNumbers: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/chartRenderer', () => ({ renderCharts: vi.fn() }));
vi.mock('../../../resources/js/lazyLoader/imageState', () => ({ handleBrokenImages: vi.fn() }));
vi.mock('../../../resources/js/components/utilities/gateFilter', () => ({ applyGateFilter: (x) => x }));
vi.mock('../../../resources/js/utilities/operationState', () => ({ isNewlyCreatedHighlight: () => false }));
vi.mock('../../../resources/js/utilities/logger', () => ({ verbose: { content: vi.fn() } }));

import { createChunkElement } from '../../../resources/js/lazyLoader/chunkRender';

/** The exact per-node shape DatabaseToIndexedDBController returns (post-fix: chunk_id a number,
 *  decimals preserved by the (float) read-back cast). */
function backendNode(chunkId, startLine) {
  return {
    book: 'bookA',
    chunk_id: chunkId,
    startLine,
    node_id: `bookA_n${startLine}`,
    content: `node ${startLine}`,
    plainText: `node ${startLine}`,
    type: null,
    footnotes: [],
    hypercites: [],
    hyperlights: [],
    raw_json: {},
  };
}

/** Mirror the loader's grouping idiom (lazyLoader/index.ts:778 distinct chunk_ids + :947 filter):
 *  one chunk div per distinct chunk_id value. */
function groupIntoChunks(nodes) {
  const ids = [...new Set(nodes.map((n) => n.chunk_id))].sort((a, b) => a - b);
  return ids.map((id) =>
    createChunkElement(nodes.filter((n) => parseFloat(n.chunk_id) === id), { bookId: 'bookA' }),
  );
}

describe('decimal chunk readback → distinct chunk divs (lifecycle hop ⑥)', () => {
  it('stamps a decimal chunk_id faithfully into data-chunk-id (not truncated to an int)', () => {
    const div = createChunkElement([backendNode(4.5, 450)], { bookId: 'bookA' });
    expect(div.getAttribute('data-chunk-id')).toBe('4.5'); // not "4", not "5"
  });

  it('keeps chunk 4 and chunk 4.5 as TWO distinct divs — no integer-collapse merge', () => {
    // A flat readback list: chunk 4 (1 node), chunk 4.5 (2 nodes), chunk 5 (1 node).
    const nodes = [
      backendNode(4, 400),
      backendNode(4.5, 450),
      backendNode(4.5, 451),
      backendNode(5, 500),
    ];

    const chunks = groupIntoChunks(nodes);

    // Three distinct chunk divs, in order — the fractional one survives between its neighbours.
    expect(chunks.map((c) => c.getAttribute('data-chunk-id'))).toEqual(['4', '4.5', '5']);

    // The fractional chunk owns EXACTLY its 2 nodes — it did not absorb chunk 4's node
    // (that absorption — a >100-node merged div — was the old (int)-truncation collision).
    const frac = chunks.find((c) => c.getAttribute('data-chunk-id') === '4.5');
    expect(frac.querySelectorAll('[id]').length).toBe(2);
    const intChunk = chunks.find((c) => c.getAttribute('data-chunk-id') === '4');
    expect(intChunk.querySelectorAll('[id]').length).toBe(1);
  });
});
