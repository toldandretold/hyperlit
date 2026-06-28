/**
 * Stale-recovery hard cleanse.
 *
 * When the server has a newer version of a book than this client and our
 * unsynced edit can't reconcile (409 STALE_DATA) — or a cross-tab edit makes
 * the open book stale — the only safe recovery is to throw away the local copy
 * and pull the server's version fresh on the next load.
 *
 * A plain `window.location.reload()` does NOT do this: on reload `loadHyperText`
 * finds the (stale) cached copy in IndexedDB and re-renders it, so the book never
 * refreshes and the 409 loops forever. This helper does a *proper* local refresh:
 * it wipes the book's IndexedDB data + the service-worker caches first, so the
 * reload finds an empty cache and fetches fresh from the server.
 *
 * Modules are dynamic-imported so this stays a zero-static-import leaf (no cycle
 * risk against the IDB / cache / sync layers that may import utilities).
 */
export async function hardRefreshStaleBook(bookId: string | null | undefined): Promise<void> {
  try {
    if (bookId) {
      // 1. Drop this book's queued (un-syncable) edits so a cleanse-then-pull
      //    doesn't immediately re-POST them and 409 again.
      try {
        const [{ clearPendingSyncsForBook }, { asBookId }] = await Promise.all([
          import('../indexedDB/syncQueue/queue'),
          import('../indexedDB/types'),
        ]);
        clearPendingSyncsForBook(asBookId(bookId));
      } catch (e) {
        console.warn('staleRecovery: could not clear pending syncs', e);
      }

      // 2. Wipe the stale book's local IndexedDB data so the reload pulls fresh.
      try {
        const { openDatabase } = await import('../indexedDB/core/connection.js');
        const { clearBookDataFromIndexedDB } = await import('../indexedDB/serverSync/index');
        const db = await openDatabase();
        await clearBookDataFromIndexedDB(db, bookId);
        console.log(`🧹 Cleared stale local data for book ${bookId}`);
      } catch (e) {
        console.warn('staleRecovery: could not clear book IndexedDB', e);
      }
    }

    // 3. Cleanse the service-worker caches (busts stale JS/assets too).
    try {
      const { clearBrowserCache } = await import('../components/userContainer/cache');
      await clearBrowserCache();
      console.log('🧹 Cleared browser caches');
    } catch (e) {
      console.warn('staleRecovery: could not clear browser caches', e);
    }
  } finally {
    // 4. Reload — now the cache is empty for this book, so it pulls fresh.
    window.location.reload();
  }
}
