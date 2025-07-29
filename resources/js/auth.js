import { getLibraryObjectFromIndexedDB } from './cache-indexedDB.js';
 
// Internal state
let currentUserInfo = null;
let anonymousToken = null;
let authInitialized = false;
let initializeAuthPromise = null;

// Export a getter function
export function getCurrentUserInfo() {
  console.log('AUTH_GETTER: getCurrentUserInfo() called. Returning:', currentUserInfo);
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

  console.log("🔄 Initializing authentication via unified session endpoint...");

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
      console.log("✅ User authenticated:", currentUserInfo);
    } else if (data.anonymous_token) {
      currentUserInfo = null;
      anonymousToken = data.anonymous_token;
      console.log("✅ Anonymous session established:", anonymousToken);
    } else {
      // This case should ideally not be reached if the backend is correct.
      console.error("❌ Server did not provide user or anonymous token.");
    }

    // IMPORTANT: Set the CSRF token for subsequent POST/PUT requests
    // We get it from the response body to avoid timing issues with cookies.
    if (data.csrf_token) {
      // Store it somewhere accessible, e.g., on a global object or in a module-level variable.
      // For simplicity, let's attach it to the window for now.
      window.csrfToken = data.csrf_token;
      console.log("✅ CSRF token received and stored.");
    }

    authInitialized = true;
  } catch (error) {
    console.error("❌ Error initializing auth:", error);
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
  console.log(`🔍 getAuthorId() - checking for anonymous token`);
  
  if (anonymousToken) {
    console.log(`✅ getAuthorId() - using server token: ${anonymousToken}`);
    return anonymousToken;
  }
  
  // Fallback to old localStorage method for compatibility during transition
  const KEY = 'authorId';
  let id = localStorage.getItem(KEY);
  
  if (!id) {
    console.log(`⚠️ getAuthorId() - no server token available, auth may not be initialized`);
    // Don't generate client-side UUIDs anymore, return null to trigger auth init
    return null;
  }
  
  console.log(`⚠️ getAuthorId() - using legacy localStorage ID: ${id}`);
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

export async function canUserEditBook(bookId) {
  try {
    // ✅ NEW DIAGNOSTIC LOG: Let's see what's in sessionStorage right now.
    const pendingSyncJSON = sessionStorage.getItem("pending_new_book_sync");
    console.log(
      `[canUserEditBook] Checking permissions for book: ${bookId}`
    );
    console.log(
      `[canUserEditBook] Found pending sync in sessionStorage:`,
      pendingSyncJSON
    );

    if (pendingSyncJSON) {
      const pendingData = JSON.parse(pendingSyncJSON);
      // Check if the pending book ID matches the one we're checking permissions for.
      if (pendingData.bookId === bookId) {
        console.log(
          "✅ Granting optimistic edit permission for pending new book."
        );
        return true; // Grant permission immediately
      }
    }

    // If we get here, it's not a pending new book, so proceed with the normal checks.
    console.log(
      `[canUserEditBook] Not a pending book, proceeding with standard auth check.`
    );

    // Ensure auth is initialized
    if (!authInitialized) {
      await initializeAuth();
    }

    // 1) fetch the library record
    const record = await getLibraryObjectFromIndexedDB(bookId);
    if (!record) {
      console.log("📚 Book not found in IndexedDB");
      return false;
    }

    // 2) check login state
    const user = await getCurrentUser();
    if (user) {
      const userId = user.name || user.username || user.email;
      const ok = record.creator === userId;
      console.log(
        "🔐 Logged in:",
        userId,
        "creator:",
        record.creator,
        "ok=",
        ok
      );
      return ok;
    }

    // 3) anonymous path — use server token
    console.log("👤 Anon edit check:", anonymousToken, record.creator_token);
    return anonymousToken !== null && record.creator_token === anonymousToken;
  } catch (err) {
    console.error("❌ Error in canUserEditBook:", err);
    return false;
  }
}


// DEPRECATED: Keep for backward compatibility but log warning
function readAnonId() {
  console.warn('⚠️ readAnonId() is deprecated, using server-managed tokens');
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

// Call this after successful login to update state
export function setCurrentUser(user) {
  currentUserInfo = user;
  anonymousToken = null;
  authInitialized = true;
}

// Call this after logout to reset state
export function clearCurrentUser() {
  resetAuth();
  // Re-initialize to get new anonymous session
  initializeAuth();
}