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



export async function canUserEditBook(bookId) {
  try {
    // Get current user
    const user = await getCurrentUser();
    if (!user) {
      console.log("No user logged in");
      return false;
    }

    // Get book data from IndexedDB
    const libraryRecord = await getLibraryObjectFromIndexedDB(bookId);
    if (!libraryRecord) {
      console.log("Book not found in IndexedDB");
      return false;
    }

    // Check if user is the creator
    const userIdentifier = user.name || user.username || user.email;
    const canEdit = libraryRecord.creator === userIdentifier;
    
    console.log(`Edit permission check: user="${userIdentifier}", creator="${libraryRecord.creator}", canEdit=${canEdit}`);
    
    return canEdit;
  } catch (error) {
    console.error('Error checking edit permission:', error);
    return false;
  }
}