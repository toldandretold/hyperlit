/**
 * Unit tests for the paginator's pure page math (scrolling/paginator.ts).
 *
 * The engine's geometry is measured live in the browser; what CAN drift
 * silently is the offset→page mapping, whose rounding rules encode two real
 * failure modes:
 *   - sub-pixel column rounding (Safari) nudging a column-start element a
 *     fraction of a px LEFT of its true page boundary → must not round DOWN
 *     to the previous page;
 *   - block indents (blockquote/li) shifting an element RIGHT within its
 *     column → must not bump it UP to the next page.
 *
 * Runs in `npm test` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import { pageFromOffsets } from '../../../resources/js/scrolling/paginator';

describe('paginator pageFromOffsets', () => {
  const PAD_L = 40;
  const STRIDE = 400; // colWidth 320 + gap 80

  it('maps column-start elements to their page', () => {
    // Element at the exact start of page N: elLeft = mainLeft + padL + N*stride
    for (const n of [0, 1, 2, 7]) {
      expect(pageFromOffsets(100 + PAD_L + n * STRIDE, 100, PAD_L, STRIDE)).toBe(n);
    }
  });

  it('absorbs sub-pixel drift LEFT of a page boundary (Safari column rounding)', () => {
    // 0.4px left of page 3's true start must still be page 3, not page 2.
    expect(pageFromOffsets(100 + PAD_L + 3 * STRIDE - 0.4, 100, PAD_L, STRIDE)).toBe(3);
  });

  it('does not bump an indented element to the next page', () => {
    // A blockquote indented 60px into page 2's column stays on page 2.
    expect(pageFromOffsets(100 + PAD_L + 2 * STRIDE + 60, 100, PAD_L, STRIDE)).toBe(2);
  });

  it('clamps to page 0 and tolerates a degenerate stride', () => {
    expect(pageFromOffsets(0, 100, PAD_L, STRIDE)).toBe(0); // left of content start
    expect(pageFromOffsets(500, 100, PAD_L, 0)).toBe(0);    // unmeasured stride
  });

  it('cancels the active transform (same shift on both rects)', () => {
    // Page 4 shown → both main and element rects shift left by 4*stride; the
    // element on page 5 must still resolve to page 5.
    const shift = -4 * STRIDE;
    expect(pageFromOffsets(100 + PAD_L + 5 * STRIDE + shift, 100 + shift, PAD_L, STRIDE)).toBe(5);
  });
});
