/**
 * virtualMap — the custom scrollbar's whole-book coordinate space.
 *
 * Locks the pure math the scrollbar + minimap depend on: cumulative offsets,
 * index↔virtual round-trips, per-tag height branches, chunk bounds over
 * decimal chunk ids, unsorted-input tolerance (background download pushes
 * chunks in completion order), and the precomputed minimap render list.
 */
import { describe, it, expect } from 'vitest';
import {
  buildVirtualMap,
  estimateNode,
  indexAtVirtual,
  virtualOfIndex,
  isMapStale,
} from '../../../resources/js/components/customScrollbar/virtualMap';

const METRICS = { lineHeight: 24, charsPerLine: 60, blockMargin: 18 };

let lineCounter = 0;
function makeNode(content, { startLine, chunk_id = 0, hyperlights = [], hypercites = [] } = {}) {
  lineCounter += 1;
  return {
    book: 'test-book',
    startLine: startLine ?? lineCounter * 100,
    chunk_id,
    node_id: `test-book_${lineCounter}`,
    content,
    hyperlights,
    hypercites,
    footnotes: [],
  };
}

function para(words = 30, opts = {}) {
  return makeNode(`<p>${'word '.repeat(words).trim()}</p>`, opts);
}

describe('buildVirtualMap offsets', () => {
  it('produces strictly increasing offsets with length n+1 and totalHeight at the end', () => {
    const nodes = [para(10), para(200), para(1), makeNode('<h1 id="7">Title</h1>')];
    const map = buildVirtualMap(nodes, METRICS);

    expect(map.offsets.length).toBe(nodes.length + 1);
    for (let i = 0; i < nodes.length; i++) {
      expect(map.offsets[i + 1]).toBeGreaterThan(map.offsets[i]);
    }
    expect(map.offsets[0]).toBe(0);
    expect(map.totalHeight).toBe(map.offsets[nodes.length]);
    expect(map.sourceLength).toBe(nodes.length);
  });

  it('sorts a copy by startLine — background download pushes chunks out of order', () => {
    const a = para(10, { startLine: 300, chunk_id: 2 });
    const b = para(10, { startLine: 100, chunk_id: 0 });
    const c = para(10, { startLine: 200.5, chunk_id: 1 });
    const nodes = [a, b, c];
    const map = buildVirtualMap(nodes, METRICS);

    expect(map.nodeIds).toEqual(['100', '200.5', '300']);
    // The input array itself must not be reordered (it's the loader's live array).
    expect(nodes[0]).toBe(a);
  });

  it('handles an empty book and a one-node book', () => {
    const empty = buildVirtualMap([], METRICS);
    expect(empty.totalHeight).toBe(0);
    expect(indexAtVirtual(empty, 50)).toBe(-1);
    expect(virtualOfIndex(empty, 3)).toBe(0);

    const single = buildVirtualMap([para(20)], METRICS);
    expect(single.nodeIds.length).toBe(1);
    expect(indexAtVirtual(single, 0)).toBe(0);
    expect(indexAtVirtual(single, single.totalHeight * 2)).toBe(0);
  });
});

describe('indexAtVirtual / virtualOfIndex round-trip', () => {
  const nodes = [para(5), para(120), makeNode('<h2 id="1">Ch</h2>'), para(60), para(1)];
  const map = buildVirtualMap(nodes, METRICS);

  it('round-trips every node top and mid-span point', () => {
    for (let i = 0; i < nodes.length; i++) {
      const top = virtualOfIndex(map, i);
      expect(indexAtVirtual(map, top)).toBe(i);
      const mid = (map.offsets[i] + map.offsets[i + 1]) / 2;
      expect(indexAtVirtual(map, mid)).toBe(i);
    }
  });

  it('clamps out-of-range queries to the ends', () => {
    expect(indexAtVirtual(map, -10)).toBe(0);
    expect(indexAtVirtual(map, 0)).toBe(0);
    expect(indexAtVirtual(map, map.totalHeight)).toBe(nodes.length - 1);
    expect(indexAtVirtual(map, map.totalHeight + 999)).toBe(nodes.length - 1);
    expect(virtualOfIndex(map, -5)).toBe(0);
    expect(virtualOfIndex(map, 999)).toBe(map.totalHeight);
  });
});

describe('estimateNode height branches', () => {
  it('makes a heading taller than a paragraph with the same text', () => {
    const text = 'Some section heading text';
    const h = estimateNode(makeNode(`<h1 id="1">${text}</h1>`), METRICS);
    const p = estimateNode(makeNode(`<p>${text}</p>`), METRICS);
    expect(h.height).toBeGreaterThan(p.height);
    expect(h.mini.kind).toBe('heading');
    expect(h.mini.level).toBe(1);
  });

  it('scales tables by row count and lists by item count', () => {
    const rows = (n) => `<table>${'<tr><td>x</td></tr>'.repeat(n)}</table>`;
    const small = estimateNode(makeNode(rows(2)), METRICS);
    const big = estimateNode(makeNode(rows(10)), METRICS);
    expect(big.height).toBeGreaterThan(small.height);
    expect(big.mini.kind).toBe('table');
    expect(big.mini.lineCount).toBe(10);

    const list = estimateNode(makeNode(`<ul>${'<li>a</li>'.repeat(7)}</ul>`), METRICS);
    expect(list.mini.kind).toBe('list');
    expect(list.mini.lineCount).toBe(7);
  });

  it('gives image-bearing nodes the flat figure height regardless of wrapper tag', () => {
    const figure = estimateNode(makeNode('<figure><img src="x.png"></figure>'), METRICS);
    const pImg = estimateNode(makeNode('<p>tiny <img src="x.png"></p>'), METRICS);
    expect(figure.mini.kind).toBe('figure');
    expect(pImg.mini.kind).toBe('figure');
    expect(figure.height).toBe(pImg.height);
    expect(figure.height).toBeGreaterThan(300);
  });

  it('counts pre lines by newlines and gives hr the rule shape', () => {
    const pre = estimateNode(makeNode('<pre>a\nb\nc</pre>'), METRICS);
    expect(pre.mini.kind).toBe('code');
    expect(pre.mini.lineCount).toBe(3);
    const hr = estimateNode(makeNode('<hr>'), METRICS);
    expect(hr.mini.kind).toBe('rule');
  });

  it('estimates long paragraphs proportionally to their text length', () => {
    const short = estimateNode(para(10), METRICS);
    const long = estimateNode(para(600), METRICS);
    expect(long.height).toBeGreaterThan(short.height * 10);
  });
});

describe('chunkBounds', () => {
  it('partitions the node range contiguously over decimal chunk ids', () => {
    const nodes = [
      para(10, { startLine: 100, chunk_id: 0 }),
      para(10, { startLine: 110, chunk_id: 0 }),
      para(10, { startLine: 120, chunk_id: 0.5 }), // fractional split chunk
      para(10, { startLine: 130, chunk_id: 1 }),
      para(10, { startLine: 140, chunk_id: 1 }),
    ];
    const map = buildVirtualMap(nodes, METRICS);

    expect(map.chunkIdsSorted).toEqual([0, 0.5, 1]);
    let cursorIdx = 0;
    let cursorV = 0;
    for (const id of map.chunkIdsSorted) {
      const bound = map.chunkBounds.get(id);
      expect(bound.startIdx).toBe(cursorIdx);
      expect(bound.vStart).toBe(cursorV);
      expect(bound.endIdx).toBeGreaterThan(bound.startIdx);
      cursorIdx = bound.endIdx;
      cursorV = bound.vEnd;
    }
    expect(cursorIdx).toBe(nodes.length);
    expect(cursorV).toBe(map.totalHeight);
  });
});

describe('minimap render list', () => {
  it('extracts + truncates heading text for h1-h3 only', () => {
    const longTitle = 'A very long chapter title that keeps going well past the truncation threshold';
    const nodes = [
      makeNode(`<h1 id="1"><em>Styled</em> Title</h1>`),
      makeNode(`<h2 id="2">${longTitle}</h2>`),
      makeNode(`<h4 id="3">Sub sub heading</h4>`),
    ];
    const map = buildVirtualMap(nodes, METRICS);

    expect(map.minimap[0].headingText).toBe('Styled Title');
    expect(map.minimap[1].headingText.length).toBeLessThanOrEqual(48);
    expect(map.minimap[1].headingText.endsWith('…')).toBe(true);
    expect(map.minimap[2].headingText).toBeUndefined();
    expect(map.minimap[2].kind).toBe('heading');
  });

  it('carries hyperlight/hypercite counts through', () => {
    const node = para(20, { hyperlights: [{}, {}], hypercites: [{}] });
    const map = buildVirtualMap([node], METRICS);
    expect(map.minimap[0].lightCount).toBe(2);
    expect(map.minimap[0].citeCount).toBe(1);
  });
});

describe('measured-height lookup', () => {
  it('measured heights win over estimates and keep offsets monotonic', () => {
    const nodes = [para(30), para(30), para(30)];
    const est = buildVirtualMap(nodes, METRICS);
    const measured = new Map([[String(nodes[1].startLine), 500]]);
    const map = buildVirtualMap(nodes, METRICS, (n) => measured.get(String(n.startLine)));

    expect(map.offsets[2] - map.offsets[1]).toBe(500);
    expect(map.offsets[1]).toBe(est.offsets[1]); // node 0 unmeasured → estimate unchanged
    for (let i = 0; i < nodes.length; i++) {
      expect(map.offsets[i + 1]).toBeGreaterThan(map.offsets[i]);
    }
  });

  it('derives the minimap lineCount from the measured height', () => {
    const map = buildVirtualMap([para(30)], METRICS, () => 24 * 10 + 18); // 10 lines + margin
    expect(map.minimap[0].lineCount).toBe(10);
  });

  it('keeps the estimate lineCount for figure nodes even when measured', () => {
    const map = buildVirtualMap(
      [makeNode('<figure><img src="x.png"></figure>')],
      METRICS,
      () => 999,
    );
    expect(map.offsets[1]).toBe(999);
    expect(map.minimap[0].kind).toBe('figure');
  });
});

describe('isMapStale', () => {
  it('is fresh for the same array and stale on identity or length change', () => {
    const nodes = [para(10), para(20)];
    const map = buildVirtualMap(nodes, METRICS);
    expect(isMapStale(map, nodes)).toBe(false);
    nodes.push(para(5));
    expect(isMapStale(map, nodes)).toBe(true);
    expect(isMapStale(map, [...nodes])).toBe(true);
  });
});
