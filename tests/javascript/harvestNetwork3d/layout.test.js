/**
 * layoutNetwork — the pure deterministic 3D placement for the harvest
 * knowledge network (x = publication year, y = −depth·gap, z = sibling fan).
 * No three import anywhere in this chain — it must stay unit-testable.
 */
import { describe, it, expect } from 'vitest';
import { layoutNetwork, yearAxis, LAYER_GAP, X_SPAN } from '../../../resources/js/harvestNetwork3d/layout';

const node = (id, over = {}) => ({
  id,
  title: id,
  author: null,
  year: null,
  status: 'assigned',
  depth: 1,
  book: null,
  cited_by_count: 0,
  url: null,
  ...over,
});

describe('layoutNetwork', () => {
  it('maps year to x monotonically across the span', () => {
    const payload = {
      nodes: [
        node('root', { status: 'root', depth: 0, year: 1980 }),
        node('a', { year: 1960 }),
        node('b', { year: 1990 }),
        node('c', { year: 2020 }),
      ],
      edges: [
        { source: 'root', target: 'a' },
        { source: 'root', target: 'b' },
        { source: 'root', target: 'c' },
      ],
    };
    const pos = layoutNetwork(payload);
    expect(pos.get('a').x).toBeLessThan(pos.get('b').x);
    expect(pos.get('b').x).toBeLessThan(pos.get('c').x);
    // Extremes land on the span edges.
    expect(pos.get('a').x).toBeCloseTo(-X_SPAN / 2);
    expect(pos.get('c').x).toBeCloseTo(X_SPAN / 2);
  });

  it('stacks depth downward: y = -depth * LAYER_GAP', () => {
    const payload = {
      nodes: [
        node('root', { status: 'root', depth: 0 }),
        node('a', { depth: 1 }),
        node('b', { depth: 2 }),
      ],
      edges: [
        { source: 'root', target: 'a' },
        { source: 'a', target: 'b' },
      ],
    };
    const pos = layoutNetwork(payload);
    expect(pos.get('root').y).toBe(0);
    expect(pos.get('a').y).toBe(-LAYER_GAP);
    expect(pos.get('b').y).toBe(-2 * LAYER_GAP);
  });

  it('gives same-parent siblings distinct z even with identical years', () => {
    const payload = {
      nodes: [
        node('root', { status: 'root', depth: 0, year: 2000 }),
        node('a', { year: 2000 }),
        node('b', { year: 2000 }),
        node('c', { year: 2000 }),
      ],
      edges: [
        { source: 'root', target: 'a' },
        { source: 'root', target: 'b' },
        { source: 'root', target: 'c' },
      ],
    };
    const pos = layoutNetwork(payload);
    const zs = ['a', 'b', 'c'].map((id) => pos.get(id).z);
    expect(new Set(zs).size).toBe(3);
  });

  it('places a yearless node near its parent x', () => {
    const payload = {
      nodes: [
        node('root', { status: 'root', depth: 0, year: 1960 }),
        node('a', { year: 2020 }),
        node('orphanYear', { depth: 2, year: null }),
      ],
      edges: [
        { source: 'root', target: 'a' },
        { source: 'a', target: 'orphanYear' },
      ],
    };
    const pos = layoutNetwork(payload);
    expect(Math.abs(pos.get('orphanYear').x - pos.get('a').x)).toBeLessThan(10);
  });

  it('is deterministic: same payload → identical positions', () => {
    const payload = {
      nodes: [
        node('root', { status: 'root', depth: 0, year: 1970 }),
        node('a', { year: 1999 }),
        node('b', { year: null }),
      ],
      edges: [
        { source: 'root', target: 'a' },
        { source: 'root', target: 'b' },
      ],
    };
    const a = layoutNetwork(payload);
    const b = layoutNetwork(payload);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('tolerates string years (the JSON payload may carry them quoted)', () => {
    const payload = {
      nodes: [
        node('root', { status: 'root', depth: 0, year: '1960' }),
        node('a', { year: '2020' }),
      ],
      edges: [{ source: 'root', target: 'a' }],
    };
    const pos = layoutNetwork(payload);
    expect(pos.get('root').x).toBeLessThan(pos.get('a').x);
  });

  it('yearAxis decimates to nice ticks instead of one label per distinct year', () => {
    // 20 distinct years clustered over 1651–2022 (the label-mash case).
    const nodes = [node('root', { status: 'root', depth: 0, year: 1867 })];
    [1651, 1680, 1689, 1755, 1756, 1759, 1767, 1776, 1798, 1814, 1817, 1821,
      1833, 1842, 1844, 1845, 1847, 2011, 2013, 2022].forEach((y, i) =>
      nodes.push(node(`n${i}`, { year: y })));
    const ticks = yearAxis({ nodes, edges: [] });

    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(9); // ~target, never per-year
    // Round-step years, strictly increasing x, inside the span.
    const step = ticks[1].year - ticks[0].year;
    ticks.slice(1).forEach((t, i) => {
      expect(t.year - ticks[i].year).toBe(step);
      expect(t.x).toBeGreaterThan(ticks[i].x);
    });
    ticks.forEach((t) => {
      expect(Math.abs(t.x)).toBeLessThanOrEqual(X_SPAN / 2);
    });
  });

  it('yearAxis is empty when there is nothing to scale (0–1 years)', () => {
    expect(yearAxis({ nodes: [node('a', { year: 2000 })], edges: [] })).toEqual([]);
    expect(yearAxis({ nodes: [node('a'), node('b')], edges: [] })).toEqual([]);
  });

  it('places every node even on degenerate input (no edges, no years)', () => {
    const payload = {
      nodes: [node('root', { status: 'root', depth: 0 }), node('a'), node('b')],
      edges: [],
    };
    const pos = layoutNetwork(payload);
    expect(pos.size).toBe(3);
  });
});
