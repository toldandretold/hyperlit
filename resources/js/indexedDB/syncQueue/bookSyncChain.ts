// Per-key async serialization, extracted so it can be unit-tested in isolation.
// Tests: tests/javascript/indexedDB/bookSyncChain.test.js
//
// syncQueue uses this to serialize unified syncs per book: the debounce does NOT await its
// async body, so two drains can run a sync for the SAME book concurrently and race on
// base_timestamp (the first to land ratchets the server clock past the other's stale base →
// a false "Book out of date" 409). Chaining each task onto the previous one for that key makes
// them run one-at-a-time, while different keys (books / sub-books) stay independent.

/**
 * Run `task` after any previously-chained task for the same `key` has settled, and record it as
 * the new tail of that key's chain. Returns the promise for THIS task (so callers can await it).
 * The stored chain entry never rejects, so a failing task can't break serialization for the key.
 */
export function runSerializedPerKey<K, T>(
  chain: Map<K, Promise<unknown>>,
  key: K,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chain.get(key) ?? Promise.resolve();
  const run = prev.then(task);
  chain.set(key, run.catch(() => {})); // keep the chain alive even if this task rejects
  return run;
}
