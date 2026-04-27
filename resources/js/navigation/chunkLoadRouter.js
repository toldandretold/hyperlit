/**
 * Chunk Load Router
 *
 * Decides whether to load the initial chunk from the local IndexedDB cache
 * or from the server, based on cache freshness and online status.
 */

import { openDatabase } from '../indexedDB/core/connection.js';
import { verbose } from '../utilities/logger.js';

/**
 * Load the initial chunk for a target, choosing the optimal source.
 *
 * @param {string} bookId
 * @param {string|null} target - Navigation target (hypercite_, HL_, etc.)
 * @param {{ fallbackTarget?: string }} [opts]
 * @returns {Promise<Object>} Same shape as fetchInitialChunk() return value
 */
export async function loadChunkForTarget(bookId, target, opts = {}) {
  const fresh = await isLocalCacheFresh(bookId);
  const online = navigator.onLine;

  if (fresh || !online) {
    verbose.content(
      `Using local cache for ${bookId} (fresh=${fresh}, online=${online})`,
      'chunkLoadRouter.js'
    );
    const { loadInitialChunkLocal } = await import('./loadInitialChunkLocal.js');
    const result = await loadInitialChunkLocal(bookId, target, opts);

    // If local load failed and we're online, fall through to server
    if (!result?.success && online) {
      verbose.content('Local load failed, falling back to server', 'chunkLoadRouter.js');
      return fetchFromServer(bookId);
    }
    return result;
  }

  verbose.content(`Fetching from server for ${bookId}`, 'chunkLoadRouter.js');
  return fetchFromServer(bookId);
}

/**
 * Fetch from server using the existing initialChunkLoader.
 * This preserves the current buildInitialChunkParams → fetchInitialChunk flow.
 */
async function fetchFromServer(bookId) {
  const { fetchInitialChunk } = await import('../initialChunkLoader.js');
  return fetchInitialChunk(bookId);
}

/**
 * Check whether the local IndexedDB cache is fresh (up-to-date with server).
 *
 * Extracts the timestamp comparison logic from checkAndUpdateIfNeeded
 * (initializePage.js) into a pure function.
 *
 * @param {string} bookId
 * @returns {Promise<boolean>} true if local data is fresh (or server unreachable)
 */
export async function isLocalCacheFresh(bookId) {
  // If offline, treat as fresh (can't check anyway)
  if (!navigator.onLine) return true;

  // Skip for virtual book IDs
  if (bookId.endsWith('/timemachine')) return true;

  // Skip if this is a pending new book that hasn't synced to server yet
  try {
    const pendingJSON = sessionStorage.getItem('pending_new_book_sync');
    if (pendingJSON) {
      const pending = JSON.parse(pendingJSON);
      if (pending.bookId === bookId) return true;
    }
  } catch { /* ignore */ }

  try {
    const [serverRecord, localRecord] = await Promise.all([
      getLibraryTimestamp(bookId),
      getLocalLibraryTimestamp(bookId),
    ]);

    // If either is missing, can't determine freshness — not fresh
    if (!serverRecord || !localRecord) return false;

    // Fresh if local timestamp is >= server timestamp for BOTH content and annotations
    if (localRecord.timestamp < serverRecord.timestamp) return false;
    if (localRecord.annotationsUpdatedAt < serverRecord.annotationsUpdatedAt) return false;
    return true;
  } catch (e) {
    console.warn('isLocalCacheFresh check failed:', e);
    // On error, assume not fresh to be safe
    return false;
  }
}

/**
 * Get the timestamp from the server's library record.
 * Lightweight — only fetches the library metadata, not full book data.
 */
async function getLibraryTimestamp(bookId) {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.success || !data.library) return null;
    return {
      timestamp: data.library.timestamp || 0,
      annotationsUpdatedAt: data.library.annotations_updated_at || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Get the timestamp from the local IndexedDB library record.
 */
async function getLocalLibraryTimestamp(bookId) {
  try {
    const db = await openDatabase();
    const tx = db.transaction('library', 'readonly');
    const store = tx.objectStore('library');

    return new Promise((resolve) => {
      const request = store.get(bookId);
      request.onsuccess = () => {
        const record = request.result;
        resolve(record ? {
          timestamp: record.timestamp || 0,
          annotationsUpdatedAt: record.annotations_updated_at || 0,
        } : null);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
