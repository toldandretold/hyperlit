/**
 * layoutDocuverse — the pure deterministic placement for the docuverse
 * (x = publication year, y = log-degree "connectedness", z = id-hash spread).
 * No three import anywhere in this chain — it must stay unit-testable.
 */
import { describe, it, expect } from 'vitest';
import { layoutDocuverse, yearAxis, degrees, X_SPAN } from '../../../resources/js/docuverse3d/layout';

const node = (id, over = {}) => ({
  id,
  kind: 'held',
  title: id,
  author: null,
  year: null,
  cited_by_count: 0,
  book: null,
  url: null,
  ...over,
});

const edge = (source, target, kind = 'hypercite') => ({ source, target, kind });

describe('layoutDocuverse', () => {
  it('maps year to x monotonically across the span', () => {
    const payload = {
      nodes: [node('a', { year: 1900 }), node('b', { year: 1950 }), node('c', { year: 2000 })],
      edges: [edge('a', 'b'), edge('b', 'c')],
      layers: [],
    };
    const pos = layoutDocuverse(payload);
    expect(pos.get('a').x).toBeCloseTo(-X_SPAN / 2);
    expect(pos.get('c').x).toBeCloseTo(X_SPAN / 2);
    expect(pos.get('a').x).toBeLessThan(pos.get('b').x);
    expect(pos.get('b').x).toBeLessThan(pos.get('c').x);
  });

  it('elevates hubs: more connections → higher y', () => {
    const payload = {
      nodes: [node('hub'), node('a'), node('b'), node('c'), node('leaf')],
      edges: [edge('hub', 'a'), edge('hub', 'b'), edge('hub', 'c'), edge('leaf', 'a')],
      layers: [],
    };
    const pos = layoutDocuverse(payload);
    expect(pos.get('hub').y).toBeGreaterThan(pos.get('leaf').y);
    // Degree map agrees.
    const deg = degrees(payload);
    expect(deg.get('hub')).toBe(3);
    expect(deg.get('leaf')).toBe(1);
  });

  it('a yearless node averages its dated neighbours x', () => {
    const payload = {
      nodes: [node('a', { year: 1900 }), node('b', { year: 2000 }), node('undated')],
      edges: [edge('undated', 'a'), edge('undated', 'b')],
      layers: [],
    };
    const pos = layoutDocuverse(payload);
    // Midpoint of the two neighbours (±small hash offset).
    expect(Math.abs(pos.get('undated').x)).toBeLessThan(8);
  });

  it('is deterministic: same payload → identical positions', () => {
    const payload = {
      nodes: [node('a', { year: 1980 }), node('b'), node('c', { year: 2010 })],
      edges: [edge('a', 'b'), edge('b', 'c')],
      layers: [],
    };
    expect([...layoutDocuverse(payload).entries()]).toEqual([...layoutDocuverse(payload).entries()]);
  });

  it('yearAxis decimates to nice round ticks', () => {
    const nodes = [1651, 1755, 1817, 1867, 1954, 2013, 2022].map((y, i) => node(`n${i}`, { year: y }));
    const ticks = yearAxis({ nodes, edges: [], layers: [] });
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(9);
    const step = ticks[1].year - ticks[0].year;
    ticks.slice(1).forEach((t, i) => expect(t.year - ticks[i].year).toBe(step));
  });

  it('handles empty payloads', () => {
    expect(layoutDocuverse({ nodes: [], edges: [], layers: [] }).size).toBe(0);
    expect(yearAxis({ nodes: [], edges: [], layers: [] })).toEqual([]);
  });
});
