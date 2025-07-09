import { getCurrentUser, getCurrentUserId } from './auth.js';
import { openDatabase } from './cache-indexedDB';

// User highlight cache
let userHighlightCaches = new Map(); // Store cache per bookId

export async function buildUserHighlightCache(bookId) {
  console.log(`🎨 Building user highlight cache for book: ${bookId}`);
  
  try {
    const db = await openDatabase();
    const transaction = db.transaction(['hyperlights'], 'readonly');
    const store = transaction.objectStore('hyperlights');
    
    // Get all highlights for this book
    const allHighlights = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    
    // ✅ FIXED: Use the existing getCurrentUserId from auth.js
    const currentUserId = await getCurrentUserId();
    
    if (!currentUserId) {
      console.warn('🎨 No current user ID, caching empty set');
      const emptySet = new Set();
      userHighlightCaches.set(bookId, emptySet);
      return emptySet;
    }
    
    console.log(`🎨 Looking for highlights by user: ${currentUserId} in book: ${bookId}`);
    console.log(`🔍 Total highlights in IndexedDB: ${allHighlights.length}`);
    
    // Filter highlights for current user
    // Check both creator and creator_token fields to handle both logged-in and anonymous users
    const userHighlights = new Set(
      allHighlights
        .filter(h => {
          const matchesBook = h.book === bookId;
          const matchesUser = h.creator === currentUserId || h.creator_token === currentUserId;
          
          console.log(`🔍 Checking highlight: book="${h.book}", creator="${h.creator}", creator_token="${h.creator_token}"`);
          console.log(`   matchesBook: ${matchesBook}, matchesUser: ${matchesUser}`);
          
          if (matchesBook && matchesUser) {
            console.log(`✅ Found user highlight: ${h.hyperlight_id} (creator: ${h.creator}, token: ${h.creator_token})`);
          }
          
          return matchesBook && matchesUser;
        })
        .map(h => h.hyperlight_id)
    );
    
    // Store in cache
    userHighlightCaches.set(bookId, userHighlights);
    
    console.log(`🎨 Cached ${userHighlights.size} user highlights for book ${bookId}`);
    return userHighlights;
    
  } catch (error) {
    console.error('❌ Error building user highlight cache:', error);
    // Return empty set on error
    const emptySet = new Set();
    userHighlightCaches.set(bookId, emptySet);
    return emptySet;
  }
}

export function getUserHighlightCache(bookId) {
  return userHighlightCaches.get(bookId) || new Set();
}

export function clearUserHighlightCache(bookId = null) {
  if (bookId) {
    userHighlightCaches.delete(bookId);
    console.log(`🧹 Cleared user highlight cache for book: ${bookId}`);
  } else {
    userHighlightCaches.clear();
    console.log(`🧹 Cleared all user highlight caches`);
  }
}

// ❌ REMOVED: Duplicate getCurrentUserId function
// The auth.js already has this function and should be the single source of truth