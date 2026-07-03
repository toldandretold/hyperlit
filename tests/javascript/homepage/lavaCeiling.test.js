/**
 * Pure-math tests for the lava-lamp rise ceiling (capRise / ceilingCapRy in
 * lavaLampBackground.ts). The invariants here back the Playwright spec
 * tests/e2e/specs/smoke/home-lava-ceiling.spec.js:
 *  - rise=0 NEVER alters a blob (the resting art can't be squashed even while
 *    the header — and so the ceiling line — still sits mid-screen), and
 *  - rise=1 is a hard cap, so the e2e ceiling assertion is deterministic at
 *    any animation phase.
 */
import { describe, it, expect } from 'vitest';
import { capRise, ceilingCapRy } from '../../../resources/js/components/homepage/lavaLampBackground';

// mirror the module's viewBox constants (BASE_Y = 1001, VW = 1600, VH = 1000)
const BASE_Y = 1001;
const VW = 1600;
const VH = 1000;
const OVERSHOOT_PX = 40;

describe('capRise', () => {
  it('is a passthrough when there is no ceiling', () => {
    expect(capRise(300, 900, null, 1)).toBe(900);
  });

  it('never squashes the resting pose: rise=0 returns ry0 exactly', () => {
    // even with the cap far BELOW the blob (header centered mid-screen at boot)
    expect(capRise(600, 600, 200, 0)).toBe(600);
    expect(capRise(600, 600, 900, 0)).toBe(600);
  });

  it('hard-caps at rise=1 when the blob would cross the ceiling', () => {
    // ry0 below the cap, rise pushes ry1 past it → exactly capRy
    expect(capRise(400, 1100, 700, 1)).toBe(700);
  });

  it('leaves blobs alone when the cap is not binding', () => {
    expect(capRise(400, 650, 700, 1)).toBe(650);
    expect(capRise(400, 650, 700, 0.5)).toBe(650);
  });

  it('compresses anim breathing that starts above the cap, proportionally to rise', () => {
    // ry0 already above capRy (anim swing): lerp from ry0 down to capRy
    expect(capRise(800, 950, 700, 0.5)).toBe(800 - 0.5 * (800 - 700));
    expect(capRise(800, 950, 700, 1)).toBe(700);
    expect(capRise(800, 950, 700, 0)).toBe(800);
  });

  it('is continuous at the ry0 = capRy crossing', () => {
    const eps = 1e-6;
    const below = capRise(700 - eps, 900, 700, 0.7);
    const above = capRise(700 + eps, 900, 700, 0.7);
    expect(Math.abs(below - above)).toBeLessThan(1e-3);
  });

  it('is monotonic in rise for a blob pinned at the cap', () => {
    let prev = -Infinity;
    for (let r = 0; r <= 1; r += 0.1) {
      const v = capRise(400, 400 + 700 * r, 700, r);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeLessThanOrEqual(700);
      prev = v;
    }
  });
});

describe('ceilingCapRy', () => {
  const wobble = 0.015;
  const allowance = 1 + 1.9 * wobble + 0.01;

  it('maps a screen line to viewBox units (height-dominant scale)', () => {
    // svg rect 1280×860 (720 viewport + 140 oversize) → scale = max(0.8, 0.86)
    const rectBottom = 860;
    const scale = Math.max(1280 / VW, 860 / VH);
    const linePx = 240;
    const yVbCeil = VH - (rectBottom - (linePx - OVERSHOOT_PX)) / scale;
    const expected = (BASE_Y - yVbCeil) / allowance;
    expect(ceilingCapRy(rectBottom, 1280, 860, linePx, wobble)).toBeCloseTo(expected, 6);
  });

  it('uses the width branch when the rect is wide', () => {
    // rect 2560×1540 → scale = max(1.6, 1.54) = 1.6
    const scale = 2560 / VW;
    const linePx = 200;
    const yVbCeil = VH - (1540 - (linePx - OVERSHOOT_PX)) / scale;
    const expected = (BASE_Y - yVbCeil) / allowance;
    expect(ceilingCapRy(1540, 2560, 1540, linePx, wobble)).toBeCloseTo(expected, 6);
  });

  it('shifts with the parallax-moved rect bottom by delta/scale (pre-allowance)', () => {
    const scale = Math.max(1280 / VW, 860 / VH);
    const a = ceilingCapRy(860, 1280, 860, 240, wobble);
    const b = ceilingCapRy(860 - 96, 1280, 860, 240, wobble); // parallax −96px
    expect(b - a).toBeCloseTo(-96 / scale / allowance, 6);
  });

  it('a HIGHER line on screen (smaller px) allows TALLER blobs', () => {
    const lineLow = ceilingCapRy(860, 1280, 860, 400, wobble);
    const lineHigh = ceilingCapRy(860, 1280, 860, 120, wobble);
    expect(lineHigh).toBeGreaterThan(lineLow);
  });

  it('guards degenerate rects and clamps to zero', () => {
    expect(ceilingCapRy(0, 0, 0, 100, wobble)).toBeNull();
    // line below the art's base → no negative caps
    expect(ceilingCapRy(860, 1280, 860, 5000, wobble)).toBe(0);
  });
});
