// cache.ts - Cache/storage management for auth changes: the "nuclear option"
// that clears IndexedDB + CacheStorage + local/sessionStorage (preserving a few
// critical keys). Leaf module (was userContainer/cacheManager.js).
import { clearDatabase } from '../../indexedDB/index';

/**
 * Clears all cached data - the "nuclear option" for auth changes.
 * Clears IndexedDB, localStorage, sessionStorage, and CacheStorage API.
 */
export async function clearAllCachedData() {
  try {
    console.log("🧹 Clearing all cached data due to auth change");

    // 1. Set cache invalidation timestamp
    const invalidationTimestamp = Date.now();
    localStorage.setItem('auth_cache_invalidation', String(invalidationTimestamp));

    // 2. Clear IndexedDB
    await clearDatabase();

    // 3. Clear browser cache storage
    await clearBrowserCache();

    // 4. Clear localStorage (preserve critical keys)
    const localStoragePreserve = ['auth_cache_invalidation'];
    const localStorageData: Record<string, string> = {};
    localStoragePreserve.forEach(key => {
      const v = localStorage.getItem(key);
      if (v) {
        localStorageData[key] = v;
      }
    });
    localStorage.clear();
    Object.entries(localStorageData).forEach(([key, value]) => {
      localStorage.setItem(key, value);
    });

    // 5. Clear sessionStorage (preserve critical keys)
    const sessionStoragePreserve = ['pending_new_book_sync', 'imported_book_flag'];
    const sessionStorageData: Record<string, string> = {};
    sessionStoragePreserve.forEach(key => {
      const v = sessionStorage.getItem(key);
      if (v) {
        sessionStorageData[key] = v;
      }
    });
    sessionStorage.clear();
    Object.entries(sessionStorageData).forEach(([key, value]) => {
      sessionStorage.setItem(key, value);
    });

    console.log("✅ All cached data cleared");
  } catch (error) {
    console.error("❌ Error clearing cached data:", error);
    // Nuclear fallback: reload the page
    window.location.reload();
  }
}

/** Clears all caches managed by the CacheStorage API */
export async function clearBrowserCache() {
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    } catch (error) {
      console.error('❌ Error clearing browser caches:', error);
    }
  }
}

/** Clears database and triggers server refresh */
export async function clearAndRefreshDatabase(serverRefreshFn: any) {
  try {
    await clearDatabase();
    await clearBrowserCache();

    if (typeof serverRefreshFn === 'function') {
      await serverRefreshFn();
    }
  } catch (error) {
    console.error("❌ Error during database refresh:", error);
    // Fallback to page reload
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  }
}
