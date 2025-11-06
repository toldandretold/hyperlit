import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateHyperciteID,
  determineRelationshipStatus,
  extractHyperciteIdFromHref,
  removeCitedINEntry,
  parseHyperciteHref,
} from '../../resources/js/hyperCites.js';

/**
 * Unit tests for hyperCites.js pure utility functions
 *
 * These tests cover the 5 pure utility functions that don't require IndexedDB mocking:
 * 1. generateHyperciteID() - Unique ID generation
 * 2. determineRelationshipStatus() - Citation relationship logic
 * 3. extractHyperciteIdFromHref() - URL parsing for hypercite IDs
 * 4. removeCitedINEntry() - Array filtering for backlinks
 * 5. parseHyperciteHref() - Full URL component parsing
 */

describe('HyperCites Utility Functions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // ===== generateHyperciteID() =====
  describe('generateHyperciteID', () => {
    it('generates ID with correct format', () => {
      const id = generateHyperciteID();

      expect(id).toMatch(/^hypercite_[a-z0-9]{7}$/);
      expect(id.startsWith('hypercite_')).toBe(true);
    });

    it('generates unique IDs', () => {
      const id1 = generateHyperciteID();
      const id2 = generateHyperciteID();
      const id3 = generateHyperciteID();

      // All IDs should be different
      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('generates IDs of consistent length', () => {
      const ids = Array.from({ length: 100 }, () => generateHyperciteID());

      // All should be "hypercite_" (10 chars) + 7 random chars = 17 total
      ids.forEach(id => {
        expect(id.length).toBe(17);
      });
    });

    it('generates IDs using only lowercase alphanumeric characters', () => {
      const ids = Array.from({ length: 50 }, () => generateHyperciteID());

      ids.forEach(id => {
        const randomPart = id.replace('hypercite_', '');
        expect(randomPart).toMatch(/^[a-z0-9]{7}$/);
      });
    });
  });

  // ===== determineRelationshipStatus() =====
  describe('determineRelationshipStatus', () => {
    it('returns "single" when citedIN length is 0', () => {
      expect(determineRelationshipStatus(0)).toBe('single');
    });

    it('returns "couple" when citedIN length is 1', () => {
      expect(determineRelationshipStatus(1)).toBe('couple');
    });

    it('returns "poly" when citedIN length is 2', () => {
      expect(determineRelationshipStatus(2)).toBe('poly');
    });

    it('returns "poly" when citedIN length is 3 or more', () => {
      expect(determineRelationshipStatus(3)).toBe('poly');
      expect(determineRelationshipStatus(5)).toBe('poly');
      expect(determineRelationshipStatus(10)).toBe('poly');
      expect(determineRelationshipStatus(100)).toBe('poly');
    });

    it('handles negative numbers (edge case)', () => {
      // Unexpected input, but function should not crash
      expect(determineRelationshipStatus(-1)).toBe('poly'); // -1 is not 0 or 1
    });
  });

  // ===== extractHyperciteIdFromHref() =====
  describe('extractHyperciteIdFromHref', () => {
    it('extracts hypercite ID from URL with hash', () => {
      const url = 'http://example.com/book#hypercite_abc1234';
      const result = extractHyperciteIdFromHref(url);

      expect(result).toBe('hypercite_abc1234');
    });

    it('extracts hypercite ID from relative URL', () => {
      const url = '/mybook#hypercite_xyz7890';
      const result = extractHyperciteIdFromHref(url);

      expect(result).toBe('hypercite_xyz7890');
    });

    it('extracts hypercite ID with complex URL', () => {
      const url = 'https://hyperlit.io/MacBride-Report#hypercite_p0pdlba';
      const result = extractHyperciteIdFromHref(url);

      expect(result).toBe('hypercite_p0pdlba');
    });

    it('returns null when hash does not start with hypercite_', () => {
      const url = 'http://example.com/book#other-anchor';
      const result = extractHyperciteIdFromHref(url);

      expect(result).toBe(null);
    });

    it('returns null when URL has no hash', () => {
      const url = 'http://example.com/book';
      const result = extractHyperciteIdFromHref(url);

      expect(result).toBe(null);
    });

    it('returns null when URL has empty hash', () => {
      const url = 'http://example.com/book#';
      const result = extractHyperciteIdFromHref(url);

      expect(result).toBe(null);
    });

    it('returns null for invalid URLs', () => {
      const url = 'not-a-valid-url';
      const result = extractHyperciteIdFromHref(url);

      expect(result).toBe(null);
    });

    it('handles URL with query parameters', () => {
      const url = 'http://example.com/book?query=test#hypercite_test123';
      const result = extractHyperciteIdFromHref(url);

      expect(result).toBe('hypercite_test123');
    });
  });

  // ===== removeCitedINEntry() =====
  describe('removeCitedINEntry', () => {
    it('removes matching hypercite ID from array', () => {
      const citedIN = [
        '/bookA#hypercite_abc123',
        '/bookB#hypercite_xyz789',
        '/bookC#hypercite_test456',
      ];

      const result = removeCitedINEntry(citedIN, 'hypercite_xyz789');

      expect(result).toHaveLength(2);
      expect(result).toEqual([
        '/bookA#hypercite_abc123',
        '/bookC#hypercite_test456',
      ]);
    });

    it('removes all matching entries if multiple exist', () => {
      const citedIN = [
        '/bookA#hypercite_abc123',
        '/bookB#hypercite_abc123',
        '/bookC#hypercite_test456',
      ];

      const result = removeCitedINEntry(citedIN, 'hypercite_abc123');

      expect(result).toHaveLength(1);
      expect(result).toEqual(['/bookC#hypercite_test456']);
    });

    it('returns original array if no match found', () => {
      const citedIN = [
        '/bookA#hypercite_abc123',
        '/bookB#hypercite_xyz789',
      ];

      const result = removeCitedINEntry(citedIN, 'hypercite_notfound');

      expect(result).toHaveLength(2);
      expect(result).toEqual(citedIN);
    });

    it('returns empty array when input is not an array', () => {
      expect(removeCitedINEntry(null, 'hypercite_test')).toEqual([]);
      expect(removeCitedINEntry(undefined, 'hypercite_test')).toEqual([]);
      expect(removeCitedINEntry('not-array', 'hypercite_test')).toEqual([]);
      expect(removeCitedINEntry(123, 'hypercite_test')).toEqual([]);
    });

    it('returns empty array when input array is empty', () => {
      const result = removeCitedINEntry([], 'hypercite_test');

      expect(result).toEqual([]);
    });

    it('preserves entries without # symbol (malformed)', () => {
      const citedIN = [
        '/bookA#hypercite_abc123',
        '/bookB-no-hash',
        '/bookC#hypercite_xyz789',
      ];

      const result = removeCitedINEntry(citedIN, 'hypercite_abc123');

      expect(result).toHaveLength(2);
      expect(result).toContain('/bookB-no-hash'); // Preserved
      expect(result).toContain('/bookC#hypercite_xyz789');
    });

    it('handles URLs with multiple # symbols', () => {
      const citedIN = [
        '/bookA#hypercite_abc123',
        '/bookB#section#hypercite_xyz789', // Malformed but shouldn't crash
      ];

      // Split extracts only the first part after #, so 'section' not 'section#hypercite_xyz789'
      const result = removeCitedINEntry(citedIN, 'section');

      expect(result).toHaveLength(1);
      expect(result).toEqual(['/bookA#hypercite_abc123']);
    });
  });

  // ===== parseHyperciteHref() =====
  describe('parseHyperciteHref', () => {
    it('parses full URL correctly', () => {
      const href = 'http://example.com/mybook#hypercite_abc123';
      const result = parseHyperciteHref(href);

      expect(result).not.toBe(null);
      expect(result.booka).toBe('mybook');
      expect(result.hyperciteIDa).toBe('hypercite_abc123');
      expect(result.citationIDa).toBe('/mybook#hypercite_abc123');
    });

    it('parses relative URL correctly', () => {
      const href = '/MacBride-Report#hypercite_p0pdlba';
      const result = parseHyperciteHref(href);

      expect(result).not.toBe(null);
      expect(result.booka).toBe('MacBride-Report');
      expect(result.hyperciteIDa).toBe('hypercite_p0pdlba');
      expect(result.citationIDa).toBe('/MacBride-Report#hypercite_p0pdlba');
    });

    it('handles URL with leading slash removed', () => {
      const href = '/book-name#hypercite_test';
      const result = parseHyperciteHref(href);

      expect(result.booka).toBe('book-name');
      expect(result.booka[0]).not.toBe('/'); // First character should not be '/'
    });

    it('handles URL without hash', () => {
      const href = 'http://example.com/mybook';
      const result = parseHyperciteHref(href);

      expect(result).not.toBe(null);
      expect(result.booka).toBe('mybook');
      expect(result.hyperciteIDa).toBe(''); // Empty hash
      expect(result.citationIDa).toBe('/mybook#');
    });

    it('handles URL with empty hash', () => {
      const href = 'http://example.com/mybook#';
      const result = parseHyperciteHref(href);

      expect(result).not.toBe(null);
      expect(result.booka).toBe('mybook');
      expect(result.hyperciteIDa).toBe(''); // Empty after #
      expect(result.citationIDa).toBe('/mybook#');
    });

    it('parses relative paths as valid URLs', () => {
      // Note: new URL() treats strings without protocol as relative paths
      const href = 'book-name#hypercite_test';
      const result = parseHyperciteHref(href);

      // Should parse successfully (relative to window.location.origin)
      expect(result).not.toBe(null);
      expect(result.booka).toBe('book-name');
      expect(result.hyperciteIDa).toBe('hypercite_test');
    });

    it('handles complex book paths', () => {
      const href = 'http://example.com/books/chapter-1/section-2#hypercite_xyz';
      const result = parseHyperciteHref(href);

      expect(result).not.toBe(null);
      expect(result.booka).toBe('books/chapter-1/section-2');
      expect(result.hyperciteIDa).toBe('hypercite_xyz');
    });

    it('handles URLs with query parameters', () => {
      const href = 'http://example.com/mybook?page=5&view=edit#hypercite_test';
      const result = parseHyperciteHref(href);

      expect(result).not.toBe(null);
      expect(result.booka).toBe('mybook');
      expect(result.hyperciteIDa).toBe('hypercite_test');
      expect(result.citationIDa).toBe('/mybook#hypercite_test');
    });

    it('handles book names with special characters', () => {
      const href = '/My-Book_Name.v2#hypercite_abc';
      const result = parseHyperciteHref(href);

      expect(result).not.toBe(null);
      expect(result.booka).toBe('My-Book_Name.v2');
      expect(result.hyperciteIDa).toBe('hypercite_abc');
    });
  });
});
