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
 * @param {object} [payload] - Optional payload with pre-fetched data
 */
// In createNewBook.js

// In createNewBook.js

export async function fireAndForgetSync(
  bookId,
  isNewBook = false,
  payload = null
) {
  // This function now returns a promise that resolves when the critical sync is done.
  return new Promise(async (resolve, reject) => {
    try {
      await updateBookTimestamp(bookId);

      if (isNewBook) {
        console.log(`🔥 Firing sequential sync for new book: ${bookId}`);
        const syncResult = await syncNewBookToPostgreSQL(
          bookId,
          payload?.libraryRecord
        );

        if (syncResult.success && syncResult.library) {
          console.log(
            "✅ Sync successful. Updating local library record with server data:",
            syncResult.library
          );
          const db = await openDatabase();
          const tx = db.transaction("library", "readwrite");
          await tx.objectStore("library").put(syncResult.library);
          await tx.done;
          console.log("✅ Local library record updated with correct owner.");
        }

        // The critical part is done. We can resolve the promise now.
        resolve();

        // The non-critical part (syncing node chunks) can continue in the background.
        await syncNodeChunksForNewBook(bookId, payload?.nodeChunks);
      } else {
        // For existing books, the sync is the whole operation.
        await syncIndexedDBtoPostgreSQL(bookId);
        resolve();
      }

      console.log(
        `[Background Sync] Successfully synced ${
          isNewBook ? "new" : "existing"
        } book: ${bookId}`
      );
    } catch (err) {
      console.error(`[Background Sync] Failed for book: ${bookId}`, err);
      await storeFallbackSync(bookId, err, isNewBook);
      reject(err); // Reject the promise on failure.
    }
  });
}

/**
 * Sync a new book to PostgreSQL using bulk-create endpoint
 * @param {string} bookId
 * @param {object} [libraryData] - Optional pre-fetched library record
 */
// In createNewBook.js

async function syncNewBookToPostgreSQL(bookId, libraryData = null) {
  try {
    let libraryRecord = libraryData;

    if (!libraryRecord) {
      console.log("No payload for library, reading from IndexedDB...");
      const db = await openDatabase();
      const tx = db.transaction(["library"], "readonly");
      libraryRecord = await tx.objectStore("library").get(bookId);
      await tx.done;
    }

    if (!libraryRecord) {
      throw new Error(`Library record not found for book: ${bookId}`);
    }

    const payload = {
      book: bookId,
      data: libraryRecord,
    };

    console.log("📤 Sending new book data to bulk-create endpoint:", payload);

    const response = await fetch(
      `${API_BASE_URL}/api/db/library/bulk-create`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // ✅ THE FIX: Add the CSRF token header, just like in your other sync functions.
          "X-CSRF-TOKEN":
            document.querySelector('meta[name="csrf-token"]')?.content,
        },
        credentials: "include", // This correctly sends the session cookie
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Server responded with ${response.status}: ${errorText}`
      );
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(`Bulk create failed: ${result.message}`);
    }

    console.log("✅ New book successfully created on server:", result);
    return result;
  } catch (error) {
    console.error("❌ Error in syncNewBookToPostgreSQL:", error);
    throw error;
  }
}



// This is the correct, offline-first version.
export async function createNewBook() {
  try {
    const db = await openDatabase();
    const bookId = "book_" + Date.now();

    // Create the records with NULL for creator fields.
    // Your Laravel backend will fill these in correctly during the sync.
    const newLibraryRecord = {
      book: bookId,
      citationID: bookId,
      title: "Untitled",
      author: null,
      type: "book",
      timestamp: Date.now(),
      creator: null,       // <-- INTENTIONALLY NULL
      creator_token: null, // <-- INTENTIONALLY NULL
    };
    newLibraryRecord.bibtex = buildBibtexEntry(newLibraryRecord);

    const initialNodeChunk = {
      book: bookId,
      startLine: 1,
      chunk_id: 0,
      content: '<h1 id="1">Untitled</h1>',
      hyperlights: [],
      hypercites: [],
    };

    // The rest of the function is correct.
    const tx = db.transaction(["library", "nodeChunks"], "readwrite");
    tx.objectStore("library").put(newLibraryRecord);
    await addNewBookToIndexedDB(
      initialNodeChunk.book,
      initialNodeChunk.startLine,
      initialNodeChunk.content,
      initialNodeChunk.chunk_id,
      tx
    );

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });

    sessionStorage.setItem(
      "pending_new_book_sync",
      JSON.stringify({
        bookId: bookId,
        isNewBook: true,
        libraryRecord: newLibraryRecord,
        nodeChunks: [initialNodeChunk],
      })
    );

    // This will now work instantly, even if you are offline.
    window.location.href = `/${bookId}/edit?target=1`;

  } catch (err) {
    console.error("createNewBook() failed:", err);
    alert("An error occurred while creating the book locally. Please try again.");
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
 * @param {Array<object>} [chunksData] - Optional pre-fetched node chunks
 */
async function syncNodeChunksForNewBook(bookId, chunksData = null) {
  try {
    let nodeChunks = chunksData;

    // If no data was passed, fall back to reading from IndexedDB
    if (!nodeChunks) {
      console.log("No payload for chunks, reading from IndexedDB...");
      const db = await openDatabase();
      const tx = db.transaction(["nodeChunks"], "readonly");
      const index = tx.objectStore("nodeChunks").index("book");
      nodeChunks = await index.getAll(bookId);
      await tx.done;
    }

    if (nodeChunks.length === 0) {
      console.log("No node chunks to sync for book:", bookId);
      return { success: true, message: "No node chunks to sync" };
    }

    console.log(
      `📤 Calling syncNodeChunksToPostgreSQL with ${nodeChunks.length} chunks`
    );
    // Your existing function should work perfectly with this data
    return await syncNodeChunksToPostgreSQL(bookId, nodeChunks);
  } catch (error) {
    console.error("❌ Error in syncNodeChunksForNewBook:", error);
    throw error;
  }
}

// Add this to your main app initialization
window.addEventListener('online', () => {
  console.log('🌐 Connection restored - retrying failed syncs...');
  retryFailedSyncs();
});