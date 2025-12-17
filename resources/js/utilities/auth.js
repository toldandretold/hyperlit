import { getLibraryObjectFromIndexedDB, clearDatabase } from '../indexedDB/index.js';
import { log, verbose } from './logger.js';

// Internal state
let currentUserInfo = null;
let anonymousToken = null;
let authInitialized = false;
let initializeAuthPromise = null;

// Export a getter function
export function getCurrentUserInfo() {
  return currentUserInfo;
}

export async function ensureAuthInitialized() {
  // If initializeAuth has already been called, return the existing promise.
  // This prevents multiple network requests.
  if (initializeAuthPromise) {
    return initializeAuthPromise;
  }
  // Otherwise, start the initialization and store the promise.
  initializeAuthPromise = initializeAuth();
  return initializeAuthPromise;
}
// In auth.js

async function initializeAuth() {
  if (authInitialized) {
    return;
  }

  log.init("Authenticating user", "/utilities/auth.js");

  try {
    // A single GET request to a new, smarter endpoint.
    // This endpoint will handle creating an anonymous session if one doesn't exist.
    const response = await fetch("/api/auth/session-info", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`Session endpoint failed with status ${response.status}`);
    }

    const data = await response.json();

    // The server now tells us everything we need to know.
    if (data.authenticated) {
      currentUserInfo = data.user;
      anonymousToken = null;
      verbose.init(`User authenticated: ${currentUserInfo?.name || "user"}`, "/utilities/auth.js");
    } else if (data.anonymous_token) {
      currentUserInfo = null;
      anonymousToken = data.anonymous_token;
      verbose.init("Anonymous session established", "/utilities/auth.js");
    } else {
      // This case should ideally not be reached if the backend is correct.
      console.error("Server did not provide user or anonymous token.");
    }

    // IMPORTANT: Set the CSRF token for subsequent POST/PUT requests
    // We get it from the response body to avoid timing issues with cookies.
    if (data.csrf_token) {
      window.csrfToken = data.csrf_token;
      // Also update the meta tag so all existing code that reads from it works
      const metaTag = document.querySelector('meta[name="csrf-token"]');
      if (metaTag) {
        metaTag.setAttribute('content', data.csrf_token);
      }
      verbose.init("CSRF token received and meta tag updated", "/utilities/auth.js");
    }

    authInitialized = true;
  } catch (error) {
    console.error("Error initializing auth:", error);
  }
}

/**
 * Handles the full logout process.
 * Makes a POST request to the server's logout endpoint, then clears all local data.
 */
export async function logout() {
  try {
    const response = await fetch('/logout', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-TOKEN': window.csrfToken
      },
    });
    if (!response.ok) console.error('Logout request failed.', response);
  } catch (error) {
    console.error('Error during logout fetch:', error);
  } finally {
    // Broadcast logout to other tabs BEFORE clearing local state
    broadcastAuthChange('logout');
    await clearCurrentUser(); // Wipes IndexedDB
    await clearBrowserCache(); // Wipes CacheStorage
    window.location.href = '/'; // Redirect to home for a fresh start
  }
}



/**
 * Clears all caches managed by the CacheStorage API.
 */
async function clearBrowserCache() {
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    } catch (error) {
      console.error('Error clearing browser caches:', error);
    }
  }
}

// Helper function to get CSRF token from cookie
function getCsrfTokenFromCookie() {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; XSRF-TOKEN=`);
  if (parts.length === 2) {
    return decodeURIComponent(parts.pop().split(';').shift());
  }
  return null;
}

// BACKWARD COMPATIBLE: Keep the same function signature
export async function getCurrentUser() {
  // First, ensure the initialization process has completed.
  await ensureAuthInitialized();
  // Then, return the now-guaranteed-to-be-correct value.
  return currentUserInfo;
}

export async function isLoggedIn() {
  const user = await getCurrentUser();
  return user !== null;
}

// BACKWARD COMPATIBLE: Keep this function but make it use server tokens
export function getAuthorId() {
  if (anonymousToken) {
    return anonymousToken;
  }

  // Fallback to old localStorage method for compatibility during transition
  const KEY = 'authorId';
  let id = localStorage.getItem(KEY);

  if (!id) {
    // Don't generate client-side UUIDs anymore, return null to trigger auth init
    return null;
  }

  return id;
}

export async function getCurrentUserId() {
  // Ensure auth is initialized
  if (!authInitialized) {
    await initializeAuth();
  }
  
  // First try to get logged-in user
  const user = await getCurrentUser();
  if (user) {
    return user.name || user.username || user.email;
  }
  
  // Fall back to anonymous token
  return anonymousToken;
}

export async function getAnonymousToken() {
  // Ensure auth is initialized
  if (!authInitialized) {
    await initializeAuth();
  }
  
  const user = await getCurrentUser();
  return user ? null : anonymousToken;
}

// In auth.js

// In auth.js




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
export function checkUserPermission(record, currentUserId, isLoggedIn = true) {
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
async function fetchLibraryFromServer(bookId) {
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

export async function canUserEditBook(bookId) {
  try {
    const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");

    if (pendingSyncJSON) {
      const pendingData = JSON.parse(pendingSyncJSON);
      // Check if the pending book ID matches the one we're checking permissions for.
      if (pendingData.bookId === bookId) {
        return true; // Grant permission immediately
      }
    }

    // Ensure auth is initialized
    if (!authInitialized) {
      await initializeAuth();
    }

    // 1) fetch the library record from IndexedDB
    let record = await getLibraryObjectFromIndexedDB(bookId);

    // 2) If not in IndexedDB, try fetching from server
    if (!record) {
      record = await fetchLibraryFromServer(bookId);

      if (!record) {
        return false;
      }
    }

    // 3) check login state and use prioritized auth logic
    const user = await getCurrentUser();
    if (user) {
      const userId = user.name || user.username || user.email;
      return checkUserPermission(record, userId, true);
    } else {
      return checkUserPermission(record, anonymousToken, false);
    }
  } catch (err) {
    console.error("Error in canUserEditBook:", err);
    return false;
  }
}


// DEPRECATED: Keep for backward compatibility but log warning
function readAnonId() {
  console.warn('readAnonId() is deprecated, using server-managed tokens');
  return anonymousToken || localStorage.getItem('authorId');
}

// Helper functions for other parts of your app
export function resetAuth() {
  currentUserInfo = null;
  anonymousToken = null;
  authInitialized = false;
  initializeAuthPromise = null;
}

export async function refreshAuth() {
  resetAuth();
  await initializeAuth();
}

// Helper function to check if user has anonymous content
async function hasAnonymousContent(token) {
  return new Promise((resolve) => {
    const request = indexedDB.open('MarkdownDB');
    request.onsuccess = (event) => {
      const db = event.target.result;
      let foundContent = false;
      let completedChecks = 0;
      const totalChecks = 2;

      const checkComplete = () => {
        completedChecks++;
        if (completedChecks === totalChecks) {
          resolve(foundContent);
        }
      };

      // Check library object store
      const libraryTransaction = db.transaction(['library'], 'readonly');
      const libraryStore = libraryTransaction.objectStore('library');
      const libraryRequest = libraryStore.getAll();

      libraryRequest.onsuccess = () => {
        const books = libraryRequest.result;
        const matchingBooks = books.filter(book => book.creator_token === token && (!book.creator || book.creator === null));
        if (matchingBooks.length > 0) {
          foundContent = true;
        }
        checkComplete();
      };

      libraryRequest.onerror = () => {
        console.error('Error checking library:', libraryRequest.error);
        checkComplete();
      };

      // Check hyperlights object store
      const highlightsTransaction = db.transaction(['hyperlights'], 'readonly');
      const highlightsStore = highlightsTransaction.objectStore('hyperlights');
      const highlightsRequest = highlightsStore.getAll();

      highlightsRequest.onsuccess = () => {
        const highlights = highlightsRequest.result;
        const matchingHighlights = highlights.filter(highlight => highlight.creator_token === token);
        if (matchingHighlights.length > 0) {
          foundContent = true;
        }
        checkComplete();
      };

      highlightsRequest.onerror = () => {
        console.error('Error checking hyperlights:', highlightsRequest.error);
        checkComplete();
      };
    };

    request.onerror = () => {
      console.error('Error opening database:', request.error);
      resolve(false);
    };
  });
}

// Call this after successful login to update state
export function setCurrentUser(user) {
  // Set the new user state
  currentUserInfo = user;
  anonymousToken = null;
  authInitialized = true;

  // Dispatch event for same-tab UI updates
  console.log('📡 Dispatching auth-state-changed (login) for same-tab UI update');
  window.dispatchEvent(new CustomEvent('auth-state-changed', {
    detail: { type: 'login', user, sameTab: true }
  }));
}


// Call this after logout to reset state
export async function clearCurrentUser() {
  resetAuth();
  // NEW: Clear all local data on logout
  await clearDatabase();
  // Re-initialize to get new anonymous session
  initializeAuth();

  // Dispatch event for same-tab UI updates
  console.log('📡 Dispatching auth-state-changed (logout) for same-tab UI update');
  window.dispatchEvent(new CustomEvent('auth-state-changed', {
    detail: { type: 'logout', sameTab: true }
  }));
}

// ============================================================================
// CROSS-TAB AUTH SYNC
// Broadcasts auth changes to other tabs so they stay in sync
// ============================================================================

let authBroadcastChannel = null;

/**
 * Initialize the auth broadcast listener
 * Call this once during app initialization
 */
/**
 * Initialize listener for same-tab auth state changes
 * Updates UI based on page type without full reload (where possible)
 */
export function initializeAuthStateListener() {
  window.addEventListener('auth-state-changed', async (event) => {
    const { type, sameTab } = event.detail;

    // Only handle same-tab events here (cross-tab handled by broadcast listener)
    if (!sameTab) return;

    const pageType = document.body.getAttribute('data-page');
    console.log(`📡 Auth state changed (${type}) on ${pageType} page`);

    if (pageType === 'user') {
      // User page: reload to get fresh server-rendered delete buttons
      console.log('🔄 Reloading user page for fresh server-rendered content...');
      window.location.reload();

    } else if (pageType === 'reader') {
      // Reader page: just update edit button permissions (no reload needed)
      console.log('🔄 Updating edit button permissions...');
      const { checkEditPermissionsAndUpdateUI } = await import('../components/editButton.js');
      await checkEditPermissionsAndUpdateUI();
    }
    // Home page doesn't need special handling - no auth-dependent UI
  });

  console.log('📡 Auth state listener initialized');
}

export function initializeAuthBroadcastListener() {
  if (authBroadcastChannel) {
    console.log('📡 Auth broadcast listener already initialized');
    return; // Already initialized
  }

  console.log('📡 Initializing auth broadcast listener...');
  authBroadcastChannel = new BroadcastChannel('auth-sync');

  authBroadcastChannel.addEventListener('message', async (event) => {
    const { type, user, timestamp } = event.data;

    console.log(`📡 RECEIVED auth broadcast: ${type}`, event.data);

    if (type === 'login') {
      // Another tab logged in - refresh our auth state
      console.log('🔄 Another tab logged in, refreshing auth state...');
      await refreshAuth();

      // Update UI to reflect logged-in state
      // Dispatch a custom event that components can listen for
      window.dispatchEvent(new CustomEvent('auth-state-changed', {
        detail: { type: 'login', user }
      }));

      // Reload the page to get fresh server-rendered content
      window.location.reload();

    } else if (type === 'logout') {
      // Another tab logged out - clear our state
      console.log('🔄 Another tab logged out, clearing state...');
      resetAuth();
      await clearDatabase();

      const pageType = document.body.getAttribute('data-page');
      console.log(`📡 Handling cross-tab logout on ${pageType} page`);

      if (pageType === 'user') {
        // User page: reload to refresh server-rendered delete buttons
        console.log('🔄 Reloading user page for fresh server-rendered content...');
        window.location.reload();

      } else if (pageType === 'reader') {
        // Reader page: update edit button permissions
        console.log('🔄 Updating edit button permissions...');
        const { checkEditPermissionsAndUpdateUI } = await import('../components/editButton.js');
        await checkEditPermissionsAndUpdateUI();

      } else {
        // Home page or unknown: redirect to home for fresh start
        window.location.href = '/';
      }
    }
  });

  console.log('📡 Auth broadcast listener initialized successfully');
}

/**
 * Broadcast an auth change to other tabs
 * @param {'login' | 'logout'} type - The type of auth change
 * @param {Object|null} user - The user object (for login) or null (for logout)
 */
export function broadcastAuthChange(type, user = null) {
  console.log(`📡 Broadcasting auth change: ${type}`, user);

  if (!authBroadcastChannel) {
    console.log('📡 Creating new BroadcastChannel for sending');
    authBroadcastChannel = new BroadcastChannel('auth-sync');
  }

  authBroadcastChannel.postMessage({
    type,
    user,
    timestamp: Date.now()
  });

  console.log(`📡 Auth change broadcasted successfully: ${type}`);
}



