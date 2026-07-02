/**
 * searchResultCache — the tiny client-side LRU shared by the three search UIs.
 * Locks: TTL expiry, LRU eviction (recency refresh on read), key isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchCacheGet, searchCacheSet, searchCacheClear } from '../../../resources/js/search/searchResultCache';

beforeEach(() => {
  searchCacheClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('searchResultCache', () => {
  it('returns stored values by exact key', () => {
    searchCacheSet('/api/search/library?q=marx', { results: [1, 2] });
    expect(searchCacheGet('/api/search/library?q=marx')).toEqual({ results: [1, 2] });
  });

  it('misses on a different key (scope/offset isolation lives in the URL)', () => {
    searchCacheSet('/api/search/combined?q=marx&sourceScope=public', { results: ['public'] });
    expect(searchCacheGet('/api/search/combined?q=marx&sourceScope=mine')).toBeNull();
    expect(searchCacheGet('/api/search/combined?q=marx&sourceScope=public&offset=15')).toBeNull();
  });

  it('expires entries after the TTL', () => {
    searchCacheSet('key', 'value');
    vi.advanceTimersByTime(119_000);
    expect(searchCacheGet('key')).toBe('value');
    vi.advanceTimersByTime(2_000); // past 120s
    expect(searchCacheGet('key')).toBeNull();
  });

  it('evicts the least-recently-USED entry beyond 50 entries', () => {
    for (let i = 0; i < 50; i++) {
      searchCacheSet(`key-${i}`, i);
    }
    // Touch key-0 so it becomes most-recent; key-1 is now the LRU.
    expect(searchCacheGet('key-0')).toBe(0);

    searchCacheSet('key-50', 50); // overflows → evicts key-1, not key-0

    expect(searchCacheGet('key-1')).toBeNull();
    expect(searchCacheGet('key-0')).toBe(0);
    expect(searchCacheGet('key-50')).toBe(50);
  });

  it('overwrites an existing key without growing the cache', () => {
    searchCacheSet('key', 'old');
    searchCacheSet('key', 'new');
    expect(searchCacheGet('key')).toBe('new');
  });

  it('clear empties everything', () => {
    searchCacheSet('a', 1);
    searchCacheSet('b', 2);
    searchCacheClear();
    expect(searchCacheGet('a')).toBeNull();
    expect(searchCacheGet('b')).toBeNull();
  });
});
