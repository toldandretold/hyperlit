/**
 * Tiny client-side LRU cache for search API responses, shared by the three
 * search UIs (homepage search, citation modal, cite-form import search).
 *
 * Why: every keystroke edit (backspace, retype) used to re-fetch identical
 * queries from the server. The request URL is the cache key — it already
 * encodes query, scope, shelfId, limit and offset, so entries can never leak
 * across scopes or pagination pages.
 *
 * Callers must NOT cache responses with `external_pending: true` (thin pages
 * whose background external ingest is still running) — the one-shot re-query
 * needs to hit the server. See scheduleExternalRetry call sites.
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const MAX_ENTRIES = 50;
const TTL_MS = 120_000;

// Map preserves insertion order — delete+set on read gives LRU behaviour.
const store = new Map<string, CacheEntry>();

export function searchCacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  // Refresh recency
  store.delete(key);
  store.set(key, entry);
  return entry.value as T;
}

export function searchCacheSet(key: string, value: unknown): void {
  if (store.has(key)) store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
  while (store.size > MAX_ENTRIES) {
    // Oldest = first inserted (Map iteration order)
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function searchCacheClear(): void {
  store.clear();
}
