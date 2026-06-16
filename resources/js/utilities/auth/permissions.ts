// auth/permissions.ts — book edit-permission checks + the permission cache API.
// Was the canUserEditBook / checkUserPermission portion of utilities/auth.js.
import { getLibraryObjectFromIndexedDB } from '../../indexedDB/index';
import { authState, editPermissionCache } from './state';
import { initializeAuth, getCurrentUser } from './session';

/**
 * Helper function to check if user has edit permission for a record
 * Uses prioritized authentication: username first, then anonymous token only if no username
 *
 * 🔒 SECURITY: Prefers server-provided ownership flags (is_user_highlight, is_owner)
 * which don't require exposing creator_token in API responses.
 * Falls back to local comparison only for locally-created content not yet synced.
 *
 * @param {Object} record - Record with creator and optionally is_user_highlight/is_owner fields
 * @param {string|null} currentUserId - Current user ID (username for logged in, token for anon)
 * @param {boolean} isLoggedIn - Whether user is currently logged in
 * @returns {boolean} - Whether user has permission
 */
export function checkUserPermission(record: any, currentUserId: any, isLoggedIn = true) {
  if (!record) return false;

  // 🔒 SECURITY: Prefer server-calculated ownership flags (doesn't expose tokens)
  if (record.is_user_highlight !== undefined) {
    return record.is_user_highlight;
  }
  if (record.is_owner !== undefined) {
    return record.is_owner;
  }

  // Fall back to local comparison for locally-created content not yet synced
  // If record has a username (creator), ONLY use username-based auth
  if (record.creator) {
    return isLoggedIn && record.creator === currentUserId;
  }

  // If no username, use token-based auth (only for anonymous users)
  if (record.creator_token) {
    return !isLoggedIn && record.creator_token === currentUserId;
  }

  return false;
}

/**
 * Fetch library record from server as fallback
 */
async function fetchLibraryFromServer(bookId: any) {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
      },
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Server request failed: ${response.status}`);
    }

    const data = await response.json();

    // The API returns {success: true, library: {...}, book_id: ...}
    if (data && data.success && data.library) {
      return data.library;
    }

    return null;
  } catch (error) {
    console.error('Failed to fetch library record from server:', error);
    return null;
  }
}

export async function canUserEditBook(bookId: any) {
  try {
    // Time machine virtual books are always read-only
    if (bookId && bookId.endsWith('/timemachine')) {
      editPermissionCache.set(bookId, false);
      return false;
    }

    // 🚀 PERFORMANCE: Check cache first for instant return
    if (editPermissionCache.has(bookId)) {
      return editPermissionCache.get(bookId);
    }

    // Check for pending new book creation
    const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
    if (pendingSyncJSON) {
      const pendingData = JSON.parse(pendingSyncJSON);
      // Check if the pending book ID matches the one we're checking permissions for.
      if (pendingData.bookId === bookId) {
        editPermissionCache.set(bookId, true);
        return true; // Grant permission immediately
      }
    }

    // Check for pending/recently imported book
    const pendingImport = sessionStorage.getItem("pending_import_book");
    if (pendingImport === bookId) {
      editPermissionCache.set(bookId, true);
      return true; // Grant permission for imported book
    }
    const importedBookFlag = sessionStorage.getItem("imported_book_flag");
    if (importedBookFlag === bookId) {
      editPermissionCache.set(bookId, true);
      return true; // Grant permission for imported book
    }

    // 📡 OFFLINE MODE: Use cached auth state, skip network calls
    const isOffline = !navigator.onLine;

    // Ensure auth is initialized (skip network call if offline and already initialized)
    if (!authState.authInitialized) {
      if (isOffline) {
        // Can't initialize auth offline - check if we have local permission data
        console.log(`📡 Offline: auth not initialized, checking IndexedDB for ${bookId}`);
      } else {
        await initializeAuth();
      }
    }

    // 1) fetch the library record from IndexedDB
    let record = await getLibraryObjectFromIndexedDB(bookId);

    // 2) If not in IndexedDB, try fetching from server (skip if offline)
    if (!record) {
      if (isOffline) {
        // 📡 OFFLINE: No local record, can't verify - deny edit
        // (User must have visited page online first to cache permissions)
        console.log(`📡 Offline: no local library record for ${bookId}, denying edit`);
        editPermissionCache.set(bookId, false);
        return false;
      }

      record = await fetchLibraryFromServer(bookId);

      if (!record) {
        editPermissionCache.set(bookId, false);
        return false;
      }
    }

    // 3) check login state and use prioritized auth logic
    // 📡 OFFLINE: getCurrentUser() handles offline case by loading from localStorage
    const user = await getCurrentUser();
    let result;
    if (user) {
      const userId = user.name || user.username || user.email;
      result = checkUserPermission(record, userId, true);
    } else {
      result = checkUserPermission(record, authState.anonymousToken, false);
    }

    // Cache the result for future calls
    editPermissionCache.set(bookId, result);
    return result;
  } catch (err) {
    console.error("Error in canUserEditBook:", err);
    return false;
  }
}

/**
 * Clear cached edit permission for a specific book
 * Useful when switching books in SPA mode
 * @param {string} bookId - The book ID to clear from cache
 */
export function clearEditPermissionCache(bookId: any = null) {
  if (bookId) {
    editPermissionCache.delete(bookId);
  } else {
    editPermissionCache.clear();
  }
}
