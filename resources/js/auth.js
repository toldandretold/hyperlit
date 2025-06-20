import { getLibraryObjectFromIndexedDB } from './cache-indexedDB.js';

// auth.js
export async function getCurrentUser() {
  console.log("Checking authentication...");
  
  try {
    const response = await fetch('/auth-check', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include', // Changed from 'same-origin' to match your userContainer
    });

    console.log("Auth check response status:", response.status);

    if (response.ok) {
      const data = await response.json();
      console.log("Auth check response data:", data);
      
      // Match the same logic as your userContainer
      const user = data.authenticated ? data.user : null;
      console.log("Extracted user:", user);
      return user;
    } else if (response.status === 401) {
      console.log("User not authenticated");
      return null;
    } else {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    console.error('Error checking authentication:', error);
    return null;
  }
}

export async function isLoggedIn() {
  const user = await getCurrentUser();
  return user !== null;
}



function readAnonId() {
  return localStorage.getItem('authorId');
}

export async function canUserEditBook(bookId) {
  try {
    // 1) fetch the library record
    const record = await getLibraryObjectFromIndexedDB(bookId);
    if (!record) {
      console.log('Book not found in IndexedDB');
      return false;
    }

    // 2) check login state
    const user = await getCurrentUser();
    if (user) {
      const userId = user.name || user.username || user.email;
      const ok    = record.creator === userId;
      console.log('Logged in:', userId, 'creator:', record.creator, 'ok=', ok);
      return ok;
    }

    // 3) anonymous path — read the stored UUID
    const anonId = readAnonId();
    console.log('Anon edit check:', anonId, record.creator_token);
    return anonId !== null && record.creator_token === anonId;

  } catch (err) {
    console.error('Error in canUserEditBook:', err);
    return false;
  }
}

export function getAuthorId() {
  const KEY = 'authorId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  // also mirror it into a cookie (so Laravel can read it)
  document.cookie = `anon_author=${id}; Path=/; Max-Age=${60*60*24*365}`;
  return id;
}