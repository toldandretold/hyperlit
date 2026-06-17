/**
 * Pins that the paste insertion point preserves a DECIMAL chunk_id. The cursor's
 * chunk can be fractional (a chunk inserted between two others); truncating it
 * (parseInt) mis-grouped pasted nodes and miscounted the insertion chunk. This
 * asserts parseFloat is used so 5.5 stays 5.5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getInsertionPoint } from '../../../resources/js/paste/utils/insertion-point-calculator';

describe('getInsertionPoint — decimal chunk_id', () => {
  let originalGetSelection;

  beforeEach(() => {
    originalGetSelection = window.getSelection;
    document.body.innerHTML = `
      <div class="chunk" data-chunk-id="5.5">
        <p id="150">cursor here</p>
        <p id="200">next node</p>
      </div>`;
  });

  afterEach(() => {
    window.getSelection = originalGetSelection;
    document.body.innerHTML = '';
  });

  it('preserves a fractional chunk_id (parseFloat, not parseInt) and the before/after ids', () => {
    const cursorTextNode = document.getElementById('150').firstChild;
    // Cursor sits inside <p id="150">, which lives in the decimal chunk 5.5.
    window.getSelection = () => ({
      getRangeAt: () => ({ startContainer: cursorTextNode }),
    });

    const chunkEl = document.querySelector('.chunk');
    const result = getInsertionPoint(chunkEl, 'bookA');

    // The headline assertion: 5.5 must survive — before the fix this was 5.
    expect(result.chunkId).toBe(5.5);
    // The string node ids are carried verbatim (already decimal-safe).
    expect(result.beforeNodeId).toBe('150');
    expect(result.afterNodeId).toBe('200');
  });
});
