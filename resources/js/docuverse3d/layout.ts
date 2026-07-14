/**
 * Deterministic 3D layout for the docuverse — PURE, no three import
 * (unit-tested in tests/javascript/docuverse3d/layout.test.js).
 *
 * There is no root here (unlike the harvest tree), so the axes are global:
 *   x — publication YEAR, linear over [minYear, maxYear]; yearless nodes
 *       average their neighbours' x (they usually cite/get cited by dated
 *       works), falling back to an id-hash offset around the centre.
 *   y — CONNECTEDNESS: log(degree) · gain. Hubs float high — the works the
 *       network organises itself around are literally elevated.
 *   z — deterministic id-hash spread; anti-overlap, no meaning.
 *
 * Same input → same output; no physics, no randomness.
 */

import type { DocuversePayload, DocNode } from './types';

export const X_SPAN = 160;
export const Y_GAIN = 16;
export const Z_SPAN = 90;

export interface Position {
  x: number;
  y: number;
  z: number;
}

/** Small deterministic hash of a string → [-1, 1]. */
export function idHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return (h % 1000) / 1000;
}

function numericYear(year: DocNode['year']): number | null {
  if (year === null || year === '') return null;
  const n = typeof year === 'number' ? year : parseInt(year, 10);
  return Number.isFinite(n) ? n : null;
}

/** Edge count per node id (both directions). */
export function degrees(payload: DocuversePayload): Map<string, number> {
  const d = new Map<string, number>();
  payload.edges.forEach((e) => {
    d.set(e.source, (d.get(e.source) ?? 0) + 1);
    d.set(e.target, (d.get(e.target) ?? 0) + 1);
  });
  return d;
}

export function layoutDocuverse(payload: DocuversePayload): Map<string, Position> {
  const positions = new Map<string, Position>();
  if (payload.nodes.length === 0) return positions;

  const years = payload.nodes
    .map((n) => numericYear(n.year))
    .filter((y): y is number => y !== null);
  const minYear = years.length ? Math.min(...years) : 0;
  const maxYear = years.length ? Math.max(...years) : 0;
  const yearToX = (y: number): number =>
    maxYear === minYear ? 0 : ((y - minYear) / (maxYear - minYear)) * X_SPAN - X_SPAN / 2;

  const deg = degrees(payload);

  // Neighbour map for yearless-x averaging.
  const neighbours = new Map<string, string[]>();
  payload.edges.forEach((e) => {
    (neighbours.get(e.source) ?? neighbours.set(e.source, []).get(e.source)!).push(e.target);
    (neighbours.get(e.target) ?? neighbours.set(e.target, []).get(e.target)!).push(e.source);
  });

  // First pass: dated nodes get their year-x.
  const xById = new Map<string, number>();
  payload.nodes.forEach((n) => {
    const y = numericYear(n.year);
    if (y !== null) xById.set(n.id, yearToX(y));
  });

  payload.nodes.forEach((n) => {
    let x = xById.get(n.id);
    if (x === undefined) {
      const datedNeighbours = (neighbours.get(n.id) ?? [])
        .map((id) => xById.get(id))
        .filter((v): v is number => v !== undefined);
      x = datedNeighbours.length
        ? datedNeighbours.reduce((s, v) => s + v, 0) / datedNeighbours.length + idHash(n.id) * 4
        : idHash(n.id) * (X_SPAN / 4);
    }
    const y = Math.log2(1 + (deg.get(n.id) ?? 0)) * Y_GAIN;
    const z = idHash(n.id) * (Z_SPAN / 2);
    positions.set(n.id, { x, y, z });
  });

  return positions;
}

/**
 * Nice decimated year ticks on the same x scale (≈`target` of them);
 * same algorithm as the harvest network's axis.
 */
export function yearAxis(payload: DocuversePayload, target = 8): { year: number; x: number }[] {
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
