/**
 * Pins the decimal-awareness of lazyLoader chunk navigation. chunk_ids can be
 * fractional (a chunk inserted between two others), so "next/prev chunk" must be
 * the adjacent value in order — NOT currentId ± 1. If anyone regresses this to
 * integer arithmetic, these fail.
 */
import { describe, it, expect } from 'vitest';
import {
  selectNextChunkId,
  selectPrevChunkId,
} from '../../../resources/js/lazyLoader/utilities/chunkSelection';

const nodes = (ids) => ids.map(chunk_id => ({ chunk_id }));

describe('chunkSelection — decimal-aware navigation', () => {
  describe('node-scan fallback (fully loaded, no manifest)', () => {
    // A 5.5 chunk inserted between 5 and 6.
    const loaded = nodes([5, 5.5, 6, 7]);

    it('next: from an integer, steps to the fractional chunk (not currentId+1)', () => {
      expect(selectNextChunkId(null, loaded, 5)).toBe(5.5);
    });
    it('next: from the fractional chunk, steps to the following integer', () => {
      expect(selectNextChunkId(null, loaded, 5.5)).toBe(6);
    });
    it('prev: from an integer, steps back to the fractional chunk', () => {
      expect(selectPrevChunkId(null, loaded, 6)).toBe(5.5);
    });
    it('prev: from the fractional chunk, steps back to the integer', () => {
      expect(selectPrevChunkId(null, loaded, 5.5)).toBe(5);
    });
    it('returns null at the ends', () => {
      expect(selectNextChunkId(null, loaded, 7)).toBeNull();
      expect(selectPrevChunkId(null, loaded, 5)).toBeNull();
    });
    it('handles string chunk_ids (DOM data-chunk-id values)', () => {
      expect(selectNextChunkId(null, nodes(['5', '5.5', '6']), 5)).toBe(5.5);
    });
  });

  describe('manifest path (chunked loading)', () => {
    const manifest = [{ chunk_id: 5 }, { chunk_id: 5.5 }, { chunk_id: 6 }];

    it('next/prev follow the ordered manifest across a fractional entry', () => {
      expect(selectNextChunkId(manifest, [], 5)).toBe(5.5);
      expect(selectNextChunkId(manifest, [], 5.5)).toBe(6);
      expect(selectPrevChunkId(manifest, [], 6)).toBe(5.5);
      expect(selectPrevChunkId(manifest, [], 5.5)).toBe(5);
    });
    it('returns null past the manifest ends', () => {
      expect(selectNextChunkId(manifest, [], 6)).toBeNull();
      expect(selectPrevChunkId(manifest, [], 5)).toBeNull();
    });
  });
});
