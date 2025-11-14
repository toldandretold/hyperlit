const API_BASE_URL = window.location.origin;

// createNewBook.js (Corrected and Optimized)
import {
  openDatabase,
  updateBookTimestamp,
  addNewBookToIndexedDB,
  syncNodeChunksToPostgreSQL
} from "./indexedDB/index.js";
import { buildBibtexEntry } from "./utilities/bibtexProcessor.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
import { getCurrentUser, getAnonymousToken } from "./utilities/auth.js";
import { generateNodeId } from "./utilities/IDfunctions.js";



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
      // Store the sync start time to avoid overwriting newer local changes
      const syncStartTime = Date.now();
      await updateBookTimestamp(bookId);

      if (isNewBook) {
        console.log(`🔥 Firing sequential sync for new book: ${bookId}`);
        const syncResult = await syncNewBookToPostgreSQL(
          bookId,
          payload?.libraryRecord
        );

        if (syncResult.success && syncResult.library) {
          console.log(
            "✅ Sync successful. Checking for local changes before updating:",
            syncResult.library
          );
          const db = await openDatabase();
          const tx = db.transaction("library", "readwrite");
          const store = tx.objectStore("library");
          
          // Get current local record to check for modifications
          const currentLocal = await store.get(bookId);
          
          // Don't overwrite changes made after sync started
          if (currentLocal && currentLocal.timestamp > syncStartTime) {
            console.log("🔄 Local changes detected after sync started - preserving all local changes");
            resolve(); // Skip any server updates
            return;
          }
          
          if (currentLocal && currentLocal.timestamp > syncResult.library.timestamp) {
            // Local record has been modified since sync started - preserve local changes
            console.log("🔄 Local record is newer - preserving local changes and updating server fields only");
            
            // Update only server-specific fields while preserving local content changes
            const mergedRecord = {
              ...currentLocal, // Keep local changes (title, timestamp, etc.)
              creator: syncResult.library.creator, // Update server ownership fields
              creator_token: syncResult.library.creator_token,
              updated_at: syncResult.library.updated_at,
              created_at: syncResult.library.created_at
            };
            
            await store.put(mergedRecord);
            console.log("✅ Local library record updated with server ownership, local changes preserved.");
          } else {
            // No local changes, safe to use server data
            console.log("✅ No local changes detected - using server data");
            await store.put(syncResult.library);
            console.log("✅ Local library record updated with server data.");
          }

          // Wait for transaction to complete using proper IndexedDB API
          await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }

        // The critical part is done. We can resolve the promise now.
        resolve();

        // The non-critical part (syncing node chunks) can continue in the background.
        await syncNodeChunksForNewBook(bookId, payload?.nodeChunks, syncStartTime);
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

      // Wait for transaction to complete using proper IndexedDB API
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
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



export async function createNewBook() {
  try {
    const db = await openDatabase();
    const bookId = "book_" + Date.now();

    const newLibraryRecord = {
      book: bookId,
      title: "Untitled",
      author: null,
      type: "book",
      timestamp: Date.now(),
      creator: null,
      creator_token: null,
      visibility: "private",
    };
    newLibraryRecord.bibtex = buildBibtexEntry(newLibraryRecord);

    // Generate node_id for the initial H1 element
    const initialNodeId = generateNodeId(bookId);

    const initialNodeChunk = {
      book: bookId,
      startLine: 100,
      chunk_id: 0,
      content: `<h1 id="100" data-node-id="${initialNodeId}">Untitled</h1>`,
      node_id: initialNodeId,
      hyperlights: [],
      hypercites: [],
    };

    const tx = db.transaction(["library", "nodeChunks"], "readwrite");
    tx.objectStore("library").put(newLibraryRecord);
    await addNewBookToIndexedDB(
      initialNodeChunk.book,
      initialNodeChunk.startLine,
      initialNodeChunk.content,
      initialNodeChunk.chunk_id,
      tx,
    );

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });

    // ✅ THE CHANGE: Create the full data object here.
    const pendingSyncData = {
      bookId: bookId,
      isNewBook: true,
      libraryRecord: newLibraryRecord,
      nodeChunks: [initialNodeChunk],
    };

    // We still save to sessionStorage as a fallback for page reloads.
    sessionStorage.setItem(
      "pending_new_book_sync",
      JSON.stringify(pendingSyncData),
    );

    // ✅ Return the full object, not just the ID.
    return pendingSyncData;
  } catch (err) {
    console.error("createNewBook() failed:", err);
    alert(
      "An error occurred while creating the book locally. Please try again.",
    );
    return null; // Return null on failure.
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
async function syncNodeChunksForNewBook(bookId, chunksData = null, syncStartTime = null) {
  try {
    // Check if book content was modified after sync started by checking library timestamp
    if (syncStartTime) {
      console.log("🔍 Checking library timestamp to detect if content was modified after sync started...");
      const db = await openDatabase();
      const tx = db.transaction(["library"], "readonly");
      const libraryRecord = await tx.objectStore("library").get(bookId);

      // Wait for transaction to complete using proper IndexedDB API
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      if (libraryRecord && libraryRecord.timestamp > syncStartTime) {
        console.log("🔄 Book content has been modified after sync started - skipping node chunk sync to preserve local changes", {
          syncStartTime,
          libraryTimestamp: libraryRecord.timestamp
        });
        return { success: true, message: "Node chunks sync skipped - local changes detected" };
      }
    }

    // Always read current data from IndexedDB to avoid stale sync
    console.log("📚 Reading current nodeChunks from IndexedDB to avoid syncing stale data...");
    const db = await openDatabase();
    const tx = db.transaction(["nodeChunks"], "readonly");
    const index = tx.objectStore("nodeChunks").index("book");
    const currentNodeChunks = await index.getAll(bookId);

    // Wait for transaction to complete using proper IndexedDB API
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    if (currentNodeChunks.length === 0) {
      console.log("No node chunks to sync for book:", bookId);
      return { success: true, message: "No node chunks to sync" };
    }

    console.log(
      `📤 Calling syncNodeChunksToPostgreSQL with ${currentNodeChunks.length} current chunks`
    );
    return await syncNodeChunksToPostgreSQL(bookId, currentNodeChunks);
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