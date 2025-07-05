import { getLibraryObjectFromIndexedDB } from './cache-indexedDB.js';

// Internal state
let currentUserInfo = null;
let anonymousToken = null;
let authInitialized = false;

// Export a getter function
export function getCurrentUserInfo() {
  return currentUserInfo;
}

// Initialize auth - called automatically when needed
// auth.js - updated initializeAuth function
async function initializeAuth() {
  if (authInitialized) {
    return;
  }

  console.log("🔄 Initializing authentication...");
  
  try {
    // First, ensure we have CSRF protection
    await fetch('/sanctum/csrf-cookie', {
      credentials: 'include'
    });

    // Then check if user is logged in or has existing anonymous session
    const authResponse = await fetch('/api/auth-check', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include',
    });

    if (authResponse.ok) {
      const data = await authResponse.json();
      
      if (data.authenticated) {
        currentUserInfo = data.user;
        anonymousToken = null;
        authInitialized = true;
        console.log("✅ User authenticated:", currentUserInfo);
        return;
      } else if (data.anonymous_token) {
        anonymousToken = data.anonymous_token;
        authInitialized = true;
        console.log("✅ Existing anonymous session:", anonymousToken);
        return;
      }
    }
    
    // No valid session, create anonymous session
    console.log("🆕 Creating new anonymous session...");
    
    // Get CSRF token from cookie for the POST request
    const csrfToken = getCsrfTokenFromCookie();
    
    const anonResponse = await fetch('/api/anonymous-session', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': csrfToken // Add CSRF token
      },
      credentials: 'include',
    });
    
    if (anonResponse.ok) {
      const anonData = await anonResponse.json();
      anonymousToken = anonData.token;
      authInitialized = true;
      console.log("✅ New anonymous session created:", anonymousToken);
      return;
    }
    
    console.error("❌ Failed to establish session");
    
  } catch (error) {
    console.error('❌ Error initializing auth:', error);
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
  console.log("Checking authentication...");
  
  if (!authInitialized) {
    await initializeAuth();
  }
  
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

export async function canUserEditBook(bookId) {
  try {
    // Ensure auth is initialized
    if (!authInitialized) {
      await initializeAuth();
    }
    
    // 1) fetch the library record
    const record = await getLibraryObjectFromIndexedDB(bookId);
    if (!record) {
      console.log('📚 Book not found in IndexedDB');
      return false;
    }

    // 2) check login state
    const user = await getCurrentUser();
    if (user) {
      const userId = user.name || user.username || user.email;
      const ok = record.creator === userId;
      console.log('🔐 Logged in:', userId, 'creator:', record.creator, 'ok=', ok);
      return ok;
    }

    // 3) anonymous path — use server token
    console.log('👤 Anon edit check:', anonymousToken, record.creator_token);
    return anonymousToken !== null && record.creator_token === anonymousToken;

  } catch (err) {
    console.error('❌ Error in canUserEditBook:', err);
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