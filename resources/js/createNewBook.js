const API_BASE_URL = window.location.origin;

// createNewBook.js (Corrected and Optimized)
import {
  openDatabase,
  updateBookTimestamp,
  addNewBookToIndexedDB,
  syncNodeChunksToPostgreSQL
} from "./cache-indexedDB.js";
import { buildBibtexEntry } from "./bibtexProcessor.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
import { getCurrentUser, getAnonymousToken } from "./auth.js";



// Helper remains the same
function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
    ).toString(16)
  );
}

/**
 * Enhanced sync that handles both new books and existing books
 * @param {string} bookId
 * @param {boolean} isNewBook - Whether this is a brand new book
 */
export async function fireAndForgetSync(bookId, isNewBook = false) {
  try {
    await updateBookTimestamp(bookId);
    
    if (isNewBook) {
      console.log(`🔥 Firing parallel sync for new book: ${bookId}`);
      // ✅ RUN IN PARALLEL
      // This starts both network requests at the same time.
      // The total time will be the time of the LONGEST request, not the sum of both.
      await Promise.all([
        syncNewBookToPostgreSQL(bookId),
        syncNodeChunksForNewBook(bookId)
      ]);
    } else {
      // For existing books, the logic remains the same.
      await syncIndexedDBtoPostgreSQL(bookId);
    }
    
    console.log(`[Background Sync] Successfully synced ${isNewBook ? 'new' : 'existing'} book: ${bookId}`);
  } catch (err) {
    console.error(`[Background Sync] Failed for book: ${bookId}`, err);
    await storeFallbackSync(bookId, err, isNewBook);
  }
}

/**
 * Sync a new book to PostgreSQL using bulk-create endpoint
 * @param {string} bookId
 */
async function syncNewBookToPostgreSQL(bookId) {
  try {
    const db = await openDatabase();
    
    // Get the library record from IndexedDB - FIXED VERSION
    const tx = db.transaction(['library'], 'readonly');
    const libraryStore = tx.objectStore('library');
    
    // Create a promise to handle the async IndexedDB operation
    const libraryRecord = await new Promise((resolve, reject) => {
      const request = libraryStore.get(bookId);
      
      request.onsuccess = (event) => {
        const result = event.target.result;
        console.log('📚 Retrieved library record from IndexedDB:', result);
        resolve(result);
      };
      
      request.onerror = (event) => {
        console.error('❌ Error retrieving library record:', event.target.error);
        reject(event.target.error);
      };
    });
    
    if (!libraryRecord) {
      throw new Error(`Library record not found for book: ${bookId}`);
    }
    
    console.log('📤 Sending new book data to bulk-create endpoint:', {
      book: bookId,
      data: libraryRecord
    });
    
    const response = await fetch(`${API_BASE_URL}/api/db/library/bulk-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        book: bookId,
        data: libraryRecord
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server responded with ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    
    if (!result.success) {
      throw new Error(`Bulk create failed: ${result.message}`);
    }
    
    console.log('✅ New book successfully created on server:', result);
    return result;
    
  } catch (error) {
    console.error('❌ Error in syncNewBookToPostgreSQL:', error);
    throw error;
  }
}

export async function createNewBook() {
  try {
    // --- OPTIMIZATION 1: Parallelize Auth Calls ---
    const [user, anonymousToken] = await Promise.all([
      getCurrentUser(),
      getAnonymousToken(),
    ]);

    const creator = user ? user.name || user.username || user.email : null;
    const creator_token = user ? null : anonymousToken;

    console.log("Creating new book with", {
      creator,
      creator_token: creator_token ? "present" : "null",
      user_authenticated: !!user,
    });

    if (!creator && !creator_token) {
      throw new Error("No valid authentication - cannot create book");
    }

    // --- Local Operations: These are fast ---
    const db = await openDatabase();
    const bookId = "book_" + Date.now();

    const newLibraryRecord = {
      book: bookId,
      citationID: bookId,
      title: "Untitled",
      author: null,
      type: "book",
      timestamp: new Date().toISOString(),
      creator,
      creator_token,
    };
    newLibraryRecord.bibtex = buildBibtexEntry(newLibraryRecord);

    // --- FIX: Create a single transaction for all related writes ---
    // 1. The transaction must declare ALL object stores it will write to.
    const tx = db.transaction(["library", "nodeChunks"], "readwrite");

    // 2. Queue the first write operation (to the 'library' store).
    tx.objectStore("library").put(newLibraryRecord);

    // 3. Queue the second write operation by passing the transaction
    //    into our updated function.
    await addNewBookToIndexedDB(
      bookId,
      1,
      '<h1 id="1">Untitled</h1>',
      0,
      tx // Pass the transaction here
    );

    // 4. Now, await the completion of the single, atomic transaction.
    //    This promise will only resolve after BOTH writes are successful.
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log("Atomic local book creation successful:", newLibraryRecord);
        resolve();
      };
      tx.onerror = (e) => {
        console.error("Atomic transaction failed:", e.target.error);
        reject(e.target.error);
      };
    });

    // --- ✅ NEW APPROACH: DECOUPLE SYNC FROM NAVIGATION ---

    // 1. Store the pending sync information in sessionStorage.
    //    sessionStorage is cleared when the browser tab is closed.
    console.log(`📝 Staging book ${bookId} for background sync on next page load.`);
    sessionStorage.setItem('pending_new_book_sync', JSON.stringify({
        bookId: bookId,
        isNewBook: true
    }));

    // 2. Now, navigate to the new page.
    window.location.href = `/${bookId}/edit?target=1`;

    // The fireAndForgetSync() call is REMOVED from here.

    return newLibraryRecord;
  } catch (err) {
    console.error("createNewBook() failed:", err);
    throw err;
  }
}



/**
 * Store failed syncs for later retry
 */
async function storeFallbackSync(bookId, error, isNewBook = false) {
  try {
    const db = await openDatabase();
    
    // Make sure failedSyncs object store exists
    if (!db.objectStoreNames.contains('failedSyncs')) {
      console.warn('failedSyncs store not found, cannot store fallback');
      return;
    }
    
    const tx = db.transaction(['failedSyncs'], 'readwrite');
    tx.objectStore('failedSyncs').put({
      bookId,
      timestamp: Date.now(),
      error: error.message,
      retryCount: 0,
      isNewBook,
      syncType: isNewBook ? 'bulk-create' : 'upsert'
    });
    
    console.log(`📝 Stored failed sync for later retry: ${bookId}`);
  } catch (e) {
    console.error('Failed to store fallback sync:', e);
  }
}


/**
 * Retry failed syncs (call this when connection is restored)
 */
// In initializePage.js (or wherever this function lives)

async function retryFailedSyncs() {
  try {
    const db = await openDatabase();
    
    // Check if the store exists before trying to use it
    if (!db.objectStoreNames.contains('failedSyncs')) {
      console.log('✅ No failedSyncs store found, nothing to retry.');
      return;
    }
    
    // Step 1: Get the list of all failed syncs in a readonly transaction.
    const readTx = db.transaction(['failedSyncs'], 'readonly');
    const failedSyncsStore = readTx.objectStore('failedSyncs');
    const failedSyncs = await new Promise((resolve, reject) => {
        const request = failedSyncsStore.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
    });
    await readTx.done;

    if (failedSyncs.length === 0) {
        console.log('✅ No failed syncs to retry.');
        return;
    }
    
    console.log(`🔄 Retrying ${failedSyncs.length} failed syncs sequentially...`);
    
    // Step 2: Use a for...of loop to process each failed sync one by one.
    for (const sync of failedSyncs) {
      try {
        console.log(`🔄 Retrying sync for: ${sync.bookId}`);
        
        // Perform the actual network sync operation
        if (sync.isNewBook) {
          await syncNewBookToPostgreSQL(sync.bookId);
        } else {
          await syncIndexedDBtoPostgreSQL(sync.bookId);
        }
        
        // If sync is successful, open a NEW transaction to remove it from the failed list.
        const writeTxSuccess = db.transaction(['failedSyncs'], 'readwrite');
        await writeTxSuccess.objectStore('failedSyncs').delete(sync.bookId);
        await writeTxSuccess.done;
        
        console.log(`✅ Retry successful for: ${sync.bookId}`);
        
      } catch (retryError) {
        console.error(`❌ Retry failed for: ${sync.bookId}`, retryError);
        
        // If sync fails again, open a NEW transaction to update its retry count or delete it.
        const writeTxFail = db.transaction(['failedSyncs'], 'readwrite');
        const store = writeTxFail.objectStore('failedSyncs');
        
        sync.retryCount = (sync.retryCount || 0) + 1;
        if (sync.retryCount < 5) { // Max 5 retries
          await store.put(sync);
          console.log(`📝 Updated retry count for ${sync.bookId} to ${sync.retryCount}.`);
        } else {
          console.error(`🚫 Max retries reached for: ${sync.bookId}. Removing from queue.`);
          await store.delete(sync.bookId);
        }
        await writeTxFail.done;
      }
    }
    console.log('✅ All failed syncs have been processed.');
  } catch (e) {
    console.error('Failed to process the retry queue:', e);
  }
}
/**
 * Retrieve and sync node chunks for a new book
 * @param {string} bookId
 */
async function syncNodeChunksForNewBook(bookId) {
  try {
    const db = await openDatabase();
    
    // Get node chunks from IndexedDB
    const tx = db.transaction(['nodeChunks'], 'readonly');
    const nodeChunksStore = tx.objectStore('nodeChunks');
    const index = nodeChunksStore.index('book');
    
    const nodeChunks = await new Promise((resolve, reject) => {
      const request = index.getAll(bookId);
      
      request.onsuccess = (event) => {
        const result = event.target.result;
        console.log(`📚 Retrieved ${result.length} node chunks from IndexedDB for sync`);
        resolve(result);
      };
      
      request.onerror = (event) => {
        console.error('❌ Error retrieving node chunks:', event.target.error);
        reject(event.target.error);
      };
    });
    
    if (nodeChunks.length === 0) {
      console.log('No node chunks to sync for book:', bookId);
      return { success: true, message: 'No node chunks to sync' };
    }
    
    // Use your existing syncNodeChunksToPostgreSQL function
    console.log(`📤 Calling syncNodeChunksToPostgreSQL with ${nodeChunks.length} chunks`);
    return await syncNodeChunksToPostgreSQL(nodeChunks);
    
  } catch (error) {
    console.error('❌ Error in syncNodeChunksForNewBook:', error);
    throw error;
  }
}

// Add this to your main app initialization
window.addEventListener('online', () => {
  console.log('🌐 Connection restored - retrying failed syncs...');
  retryFailedSyncs();
});