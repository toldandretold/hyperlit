import { getLibraryObjectFromIndexedDB, clearDatabase } from '../indexedDB/index.js';
 
// Internal state
let currentUserInfo = null;
let anonymousToken = null;
let authInitialized = false;
let initializeAuthPromise = null;

// Export a getter function
export function getCurrentUserInfo() {
  console.log('AUTH_GETTER: getCurrentUserInfo() called. Returning:', currentUserInfo?.name || (currentUserInfo ? "user" : "null"));
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
      console.log("✅ User authenticated:", currentUserInfo?.name || "user");
    } else if (data.anonymous_token) {
      currentUserInfo = null;
      anonymousToken = data.anonymous_token;
      console.log("✅ Anonymous session established:", "[token]");
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

/**
 * Handles the full logout process.
 * Makes a POST request to the server's logout endpoint, then clears all local data.
 */
export async function logout() {
  console.log("🔄 Logging out...");
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
      console.log('🧹 Clearing browser caches...');
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
      console.log('✅ Browser caches cleared.');
    } catch (error) {
      console.error('❌ Error clearing browser caches:', error);
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
  console.log(`🔍 getAuthorId() - checking for anonymous token`);
  
  if (anonymousToken) {
    console.log(`✅ getAuthorId() - using server token: [token]`);
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
  
  console.log(`⚠️ getAuthorId() - using legacy localStorage ID: [legacy_id]`);
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
 * @param {Object} record - Record with creator and creator_token fields
 * @param {string|null} currentUserId - Current user ID (username for logged in, token for anon)
 * @param {boolean} isLoggedIn - Whether user is currently logged in
 * @returns {boolean} - Whether user has permission
 */
export function checkUserPermission(record, currentUserId, isLoggedIn = true) {
  if (!record) return false;
  
  // If record has a username (creator), ONLY use username-based auth
  if (record.creator) {
    console.log(`🔐 Record has username creator: ${record.creator}, checking against logged-in user: ${currentUserId}`);
    return isLoggedIn && record.creator === currentUserId;
  }
  
  // If no username, use token-based auth (only for anonymous users)
  if (record.creator_token) {
    console.log(`👤 Record has token creator: ${record.creator_token}, checking against anon user: ${currentUserId}`);
    return !isLoggedIn && record.creator_token === currentUserId;
  }
  
  console.log("❌ Record has no creator or creator_token");
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

    // 1) fetch the library record from IndexedDB
    let record = await getLibraryObjectFromIndexedDB(bookId);

    // 2) If not in IndexedDB, try fetching from server
    if (!record) {
      console.log("📚 Book not found in IndexedDB, trying server...");
      record = await fetchLibraryFromServer(bookId);

      if (!record) {
        console.log("📚 Book not found on server either");
        return false;
      }

      console.log("✅ Found book on server");
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

// Helper function to check if user has anonymous content
async function hasAnonymousContent(token) {
  console.log('🔍 Checking for anonymous content with token: [token]');
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
          console.log('✅ Content check complete. Found content:', foundContent);
          resolve(foundContent);
        }
      };

      // Check library object store
      const libraryTransaction = db.transaction(['library'], 'readonly');
      const libraryStore = libraryTransaction.objectStore('library');
      const libraryRequest = libraryStore.getAll();
      
      libraryRequest.onsuccess = () => {
        const books = libraryRequest.result;
        console.log('📚 All books in library:', books);
        const matchingBooks = books.filter(book => book.creator_token === token && (!book.creator || book.creator === null));
        console.log('📚 Books with matching creator_token:', matchingBooks);
        if (matchingBooks.length > 0) {
          foundContent = true;
        }
        checkComplete();
      };
      
      libraryRequest.onerror = () => {
        console.error('❌ Error checking library:', libraryRequest.error);
        checkComplete();
      };

      // Check hyperlights object store
      const highlightsTransaction = db.transaction(['hyperlights'], 'readonly');
      const highlightsStore = highlightsTransaction.objectStore('hyperlights');
      const highlightsRequest = highlightsStore.getAll();
      
      highlightsRequest.onsuccess = () => {
        const highlights = highlightsRequest.result;
        console.log('💡 All highlights in hyperlights:', highlights);
        const matchingHighlights = highlights.filter(highlight => highlight.creator_token === token);
        console.log('💡 Highlights with matching creator_token:', matchingHighlights);
        if (matchingHighlights.length > 0) {
          foundContent = true;
        }
        checkComplete();
      };
      
      highlightsRequest.onerror = () => {
        console.error('❌ Error checking hyperlights:', highlightsRequest.error);
        checkComplete();
      };
    };
    
    request.onerror = () => {
      console.error('❌ Error opening database:', request.error);
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
 

}


// Call this after logout to reset state
export async function clearCurrentUser() {
  resetAuth();
  // NEW: Clear all local data on logout
  await clearDatabase();
  console.log("🔒 User state cleared and local database wiped.");
  // Re-initialize to get new anonymous session
  initializeAuth();
}



