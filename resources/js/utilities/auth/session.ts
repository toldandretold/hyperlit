// auth/session.ts — session lifecycle + identity + CSRF.
// Was the init/state/csrf/user portion of utilities/auth.js. Shared state lives
// in ./state; permissions + crossTab build on these.
import { getLibraryObjectFromIndexedDB, clearDatabase } from '../../indexedDB/index';
import { verbose } from '../logger';
import { authState, editPermissionCache } from './state';
import { getCsrfTokenFromCookie } from './csrf';

// Export a getter function
export function getCurrentUserInfo() {
  return authState.currentUserInfo;
}

/**
 * Synchronous auth context getter — returns cached auth state without any
 * async/microtask overhead.  Auth is always initialized by page load
 * (initializePage.js), so this will return a valid object on every hot path.
 * Returns null only if auth hasn't been initialized yet.
 */
export function getAuthContextSync() {
  if (!authState.authInitialized) return null;
  return {
    user: authState.currentUserInfo,
    userId: authState.currentUserInfo
      ? (authState.currentUserInfo.name || authState.currentUserInfo.username || authState.currentUserInfo.email)
      : authState.anonymousToken,
    anonymousToken: authState.anonymousToken,
    isLoggedIn: authState.currentUserInfo !== null,
  };
}

/**
 * Async auth context getter — ensures auth is initialized first, then returns
 * the same shape as getAuthContextSync().  Use as fallback for the rare case
 * where auth isn't warm yet.
 */
export async function getAuthContext() {
  await ensureAuthInitialized();
  return {
    user: authState.currentUserInfo,
    userId: authState.currentUserInfo
      ? (authState.currentUserInfo.name || authState.currentUserInfo.username || authState.currentUserInfo.email)
      : authState.anonymousToken,
    anonymousToken: authState.anonymousToken,
    isLoggedIn: authState.currentUserInfo !== null,
  };
}

export async function ensureAuthInitialized() {
  // If initializeAuth has already been called, return the existing promise.
  // This prevents multiple network requests.
  if (authState.initializeAuthPromise) {
    return authState.initializeAuthPromise;
  }
  // Otherwise, start the initialization and store the promise.
  authState.initializeAuthPromise = initializeAuth();
  return authState.initializeAuthPromise;
}

export async function initializeAuth() {
  if (authState.authInitialized) {
    return;
  }

  verbose.init("Authenticating user", "/utilities/auth/session.ts");

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
      authState.currentUserInfo = data.user;
      authState.anonymousToken = null;
      verbose.init(`User authenticated: ${authState.currentUserInfo?.name || "user"}`, "/utilities/auth/session.ts");

      // 📡 OFFLINE: Cache user info to localStorage for offline access
      try {
        localStorage.setItem('hyperlit_user_cache', JSON.stringify(data.user));
        verbose.init('User info cached for offline use', '/utilities/auth/session.ts');
      } catch (e) {
        console.warn('Failed to cache user info:', e);
      }
    } else if (data.anonymous_token) {
      authState.currentUserInfo = null;
      authState.anonymousToken = data.anonymous_token;
      verbose.init("Anonymous session established", "/utilities/auth/session.ts");

      // 📡 OFFLINE: Cache anonymous token to localStorage for offline access
      try {
        localStorage.setItem('hyperlit_anon_token_cache', data.anonymous_token);
        verbose.init('Anonymous token cached for offline use', '/utilities/auth/session.ts');
      } catch (e) {
        console.warn('Failed to cache anonymous token:', e);
      }
    } else {
      // This case should ideally not be reached if the backend is correct.
      console.error("Server did not provide user or anonymous token.");
    }

    // IMPORTANT: Set the CSRF token for subsequent POST/PUT requests
    // We get it from the response body to avoid timing issues with cookies.
    if (data.csrf_token) {
      (window as any).csrfToken = data.csrf_token;
      // Also update the meta tag so all existing code that reads from it works
      const metaTag = document.querySelector('meta[name="csrf-token"]');
      if (metaTag) {
        metaTag.setAttribute('content', data.csrf_token);
      }
      verbose.init("CSRF token received and meta tag updated", "/utilities/auth/session.ts");
    }

    authState.authInitialized = true;
  } catch (error) {
    console.error("Error initializing auth:", error);
  }
}

/**
 * Fetch a fresh CSRF token from the server and update window.csrfToken + meta tag.
 * Used to recover from 419 errors when the Laravel session has expired.
 * Returns true if the user is still authenticated, false if they've been logged out.
 */
export async function refreshCsrfToken() {
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
    throw new Error(`Failed to refresh CSRF token: ${response.status}`);
  }

  const data = await response.json();

  if (data.csrf_token) {
    (window as any).csrfToken = data.csrf_token;
    const metaTag = document.querySelector('meta[name="csrf-token"]');
    if (metaTag) {
      metaTag.setAttribute('content', data.csrf_token);
    }
    console.log("🔄 CSRF token refreshed after 419");
  }

  return !!data.authenticated;
}

// BACKWARD COMPATIBLE: Keep the same function signature
export async function getCurrentUser() {
  // 📡 OFFLINE: Return cached user info if we're offline and auth was initialized
  if (!navigator.onLine && (authState.authInitialized || authState.currentUserInfo !== null)) {
    return authState.currentUserInfo;
  }

  // 📡 OFFLINE: If offline and auth not initialized, try localStorage cache
  if (!navigator.onLine) {
    try {
      const cachedUser = localStorage.getItem('hyperlit_user_cache');
      if (cachedUser) {
        const user = JSON.parse(cachedUser);
        authState.currentUserInfo = user;
        authState.anonymousToken = null;
        authState.authInitialized = true;
        console.log(`📡 Offline: loaded cached user from localStorage: ${user.name || user.email}`);
        return user;
      }

      // No cached user - try loading anonymous token for permission checks
      const cachedAnonToken = localStorage.getItem('hyperlit_anon_token_cache');
      if (cachedAnonToken) {
        authState.anonymousToken = cachedAnonToken;
        authState.authInitialized = true;
        console.log('📡 Offline: loaded cached anonymous token from localStorage');
        // Return null (no logged-in user) but anonymousToken is now set for permission checks
        return null;
      }
    } catch (e) {
      console.warn('Failed to load cached auth:', e);
    }
    console.log('📡 Offline: no cached user found, returning null');
    return null;
  }

  await ensureAuthInitialized();
  // Then, return the now-guaranteed-to-be-correct value.
  return authState.currentUserInfo;
}

export async function isLoggedIn() {
  const user = await getCurrentUser();
  return user !== null;
}

// BACKWARD COMPATIBLE: Keep this function but make it use server tokens
export function getAuthorId() {
  if (authState.anonymousToken) {
    return authState.anonymousToken;
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
  const user = await getCurrentUser();
  if (user) {
    return user.name || user.username || user.email;
  }
  return authState.anonymousToken;
}

export async function getAnonymousToken() {
  // Ensure auth is initialized
  if (!authState.authInitialized) {
    await initializeAuth();
  }

  const user = await getCurrentUser();
  return user ? null : authState.anonymousToken;
}

// DEPRECATED: Keep for backward compatibility but log warning
function readAnonId() {
  console.warn('readAnonId() is deprecated, using server-managed tokens');
  return authState.anonymousToken || localStorage.getItem('authorId');
}

// Helper functions for other parts of your app
export function resetAuth() {
  authState.currentUserInfo = null;
  authState.anonymousToken = null;
  authState.authInitialized = false;
  authState.initializeAuthPromise = null;
  // Clear edit permission cache when auth resets
  editPermissionCache.clear();
  // 📡 OFFLINE: Clear cached auth info on logout
  try {
    localStorage.removeItem('hyperlit_user_cache');
    localStorage.removeItem('hyperlit_anon_token_cache');
  } catch (e) {
    // Ignore localStorage errors
  }
}

export async function refreshAuth() {
  resetAuth();
  await initializeAuth();
}

// Helper function to check if user has anonymous content
async function hasAnonymousContent(token: any) {
  return new Promise((resolve) => {
    const request = indexedDB.open('MarkdownDB');
    request.onsuccess = (event: any) => {
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
        const matchingBooks = books.filter((book: any) => book.creator_token === token && (!book.creator || book.creator === null));
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
        const matchingHighlights = highlights.filter((highlight: any) => highlight.creator_token === token);
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
export function setCurrentUser(user: any) {
  // Set the new user state
  authState.currentUserInfo = user;
  authState.anonymousToken = null;
  authState.authInitialized = true;

  // 📡 OFFLINE: Persist user info to localStorage for offline access
  if (user) {
    try {
      localStorage.setItem('hyperlit_user_cache', JSON.stringify(user));
      console.log('📡 User info cached for offline use');
    } catch (e) {
      console.warn('Failed to cache user info:', e);
    }
  }

  // Dispatch event for same-tab UI updates
  console.log('📡 Dispatching auth-state-changed (login) for same-tab UI update');
  window.dispatchEvent(new CustomEvent('auth-state-changed', {
    detail: { type: 'login', user, sameTab: true }
  }));
}

// Call this after logout to reset state
export async function clearCurrentUser() {
  resetAuth();
  // E2EE (docs/e2ee.md): drop the IN-MEMORY vault key / DEK / registry caches —
  // logout doesn't reload the page, and clearDatabase below only removes the
  // PERSISTED copy. Without this a shared-device session keeps the keys warm.
  try {
    const [{ clearKeyCaches }, { clearEncryptedBookRegistry }, { clearBeaconOutbox }] = await Promise.all([
      import('../../e2ee/keys'),
      import('../../e2ee/registry'),
      import('../../e2ee/outbox'),
    ]);
    clearKeyCaches();
    clearEncryptedBookRegistry();
    clearBeaconOutbox();
  } catch { /* e2ee chunk unavailable (offline) — IDB wipe below still removes the persisted key */ }
  // NEW: Clear all local data on logout
  await clearDatabase();
  // Re-initialize to get new anonymous session and WAIT for it
  await initializeAuth();

  // Dispatch event for same-tab UI updates AFTER auth is re-initialized
  console.log('📡 Dispatching auth-state-changed (logout) for same-tab UI update');
  window.dispatchEvent(new CustomEvent('auth-state-changed', {
    detail: { type: 'logout', sameTab: true }
  }));
}
