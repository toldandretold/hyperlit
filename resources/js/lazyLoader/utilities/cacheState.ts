/**
 * Cache State Management
 *
 * Tracks whether the lazy loader's in-memory cache needs to be refreshed
 * from IndexedDB due to write operations (saves, deletes, paste, renumbering).
 */

let cacheIsDirty = false;

/**
 * Mark the lazy loader cache as dirty (needs refresh from IndexedDB)
 */
export function markCacheDirty() {
  cacheIsDirty = true;
}

/**
 * Check if the cache needs to be refreshed
 * @returns {boolean}
 */
export function isCacheDirty() {
  return cacheIsDirty;
}

/**
 * Clear the dirty flag after cache has been refreshed
 */
export function clearCacheDirtyFlag() {
  cacheIsDirty = false;
}
