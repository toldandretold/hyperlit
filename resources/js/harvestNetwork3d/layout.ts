/**
 * Deterministic 3D layout for the harvest knowledge network — PURE, no three
 * import (unit-tested in tests/javascript/harvestNetwork3d/layout.test.js).
 *
 * The mapping (the "how would you place a docuverse" answer, first draft):
 *   x — publication YEAR, linear over [minYear, maxYear]: reading the scene
 *       left→right is reading the literature chronologically. Yearless nodes
 *       sit near their parent (inherited x + a small id-hash offset).
 *   y — citation DEPTH from the root, root on top (y = −depth·gap): height
 *       is "how far the harvest travelled to reach this work".
 *   z — spread within a sibling group (same parent), fanned evenly plus a
 *       seeded id-hash jitter so same-year siblings never occupy one point.
 *
 * Same input → same output; no physics, no randomness.
 */

import type { NetworkPayload, Position } from './types';

export const X_SPAN = 120;
export const LAYER_GAP = 26;
export const Z_SPAN = 70;

/** Small deterministic hash of a string → [-1, 1]. */
export function idHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return (h % 1000) / 1000;
}

function numericYear(year: number | string | null): number | null {
  if (year === null || year === '') return null;
  const n = typeof year === 'number' ? year : parseInt(year, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Nice, non-overlapping ticks for the year axis (~`target` of them), on the
 * SAME linear year→x scale layoutNetwork uses. Pure like the layout — the
 * scene just draws what this returns.
 */
export function yearAxis(
  payload: NetworkPayload,
  target = 8,
): { year: number; x: number }[] {
  const years = payload.nodes
    .map((n) => numericYear(n.year))
    .filter((y): y is number => y !== null);
  if (years.length < 2) return [];
  const min = Math.min(...years);
  const max = Math.max(...years);
  if (max === min) return [];

  const span = max - min;
  const mag = 10 ** Math.floor(Math.log10(span / target));
  const step =
    [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= target) ?? 10 * mag;

  const ticks: { year: number; x: number }[] = [];
  for (let y = Math.ceil(min / step) * step; y <= max; y += step) {
    ticks.push({ year: y, x: ((y - min) / span) * X_SPAN - X_SPAN / 2 });
  }
  return ticks;
}

export function layoutNetwork(payload: NetworkPayload): Map<string, Position> {
  const positions = new Map<string, Position>();
  const nodes = payload.nodes;
  if (nodes.length === 0) return positions;

  // Year → x scale over the known years.
  const years = nodes
    .map((n) => numericYear(n.year))
    .filter((y): y is number => y !== null);
  const minYear = years.length ? Math.min(...years) : 0;
  const maxYear = years.length ? Math.max(...years) : 0;
  const yearToX = (y: number): number =>
    maxYear === minYear
      ? 0
      : ((y - minYear) / (maxYear - minYear)) * X_SPAN - X_SPAN / 2;

  // Parent + sibling-group wiring from the edges.
  const parentOf = new Map<string, string>();
  payload.edges.forEach((e) => {
    if (e.target !== e.source) parentOf.set(e.target, e.source);
  });
  const siblings = new Map<string, string[]>(); // parent id → child ids, input order
  nodes.forEach((n) => {
    const p = parentOf.get(n.id);
    if (p === undefined) return;
    const group = siblings.get(p) ?? [];
    group.push(n.id);
    siblings.set(p, group);
  });

  // Place in depth order so a yearless child can inherit its parent's x.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ordered = [...nodes].sort((a, b) => a.depth - b.depth);

  ordered.forEach((node) => {
    const year = numericYear(node.year);
    const parentPos = positions.get(parentOf.get(node.id) ?? '');
    const x =
      year !== null
        ? yearToX(year)
        : (parentPos?.x ?? 0) + idHash(node.id) * 6;

    const y = -node.depth * LAYER_GAP + 0; // + 0 normalizes -0 at depth 0

    // Fan siblings across the z axis; a lone child sits on its parent's z.
    const group = siblings.get(parentOf.get(node.id) ?? '') ?? [];
    const idx = group.indexOf(node.id);
    const fan =
      group.length > 1 && idx >= 0
        ? (idx / (group.length - 1)) * Z_SPAN - Z_SPAN / 2
        : (parentPos?.z ?? 0);
    const z = fan + idHash(node.id) * 3;

    positions.set(node.id, { x, y, z });
  });

  // Keep every payload node placed even if depth data is degenerate.
  nodes.forEach((n) => {
    if (!positions.has(n.id) && byId.has(n.id)) {
      positions.set(n.id, { x: 0, y: 0, z: 0 });
    }
  });

  return positions;
}
