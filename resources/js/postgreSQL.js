import { openDatabase, parseNodeId } from "./cache-indexedDB.js";
import { getCurrentUser, getAuthorId } from "./auth.js";

async function syncBookDataToServer(bookName, objectStoreName, method = 'upsert') {
    const storeConfig = {
        nodeChunks: {
            endpoint: `/api/db/node-chunks/${method}`,
            keyRange: IDBKeyRange.bound([bookName, 0], [bookName, Number.MAX_VALUE]),
            useCompositeKey: true
        },
        hyperlights: {
            endpoint: `/api/db/hyperlights/${method}`,
            keyRange: IDBKeyRange.bound([bookName, ''], [bookName, '\uffff']),
            useCompositeKey: true
        },
        hypercites: {
            endpoint: `/api/db/hypercites/${method}`,
            keyRange: IDBKeyRange.bound([bookName, ''], [bookName, '\uffff']),
            useCompositeKey: true
        },
        library: {
            endpoint: `/api/db/library/${method}`,
            keyRange: IDBKeyRange.only(bookName),
            useCompositeKey: false
        },
        footnotes: {
            endpoint: `/api/db/footnotes/${method}`,
            keyRange: IDBKeyRange.only(bookName),
            useCompositeKey: false
        }
    };

    console.log(`🔄 Sync attempt for ${objectStoreName} from window/tab ${window.name || 'unnamed'}`);
    
    try {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("MarkdownDB", 15);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        const tx = db.transaction([objectStoreName], "readonly");
        const store = tx.objectStore(objectStoreName);
        
        // Get all data first
        const allData = await new Promise((resolve) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
        });

        console.log(`📊 ${objectStoreName} total records:`, allData.length);
        
        // Try both book ID formats
        const bookNameWithoutSlash = bookName.replace('/', '');
        const bookNameWithSlash = bookName.startsWith('/') ? bookName : `/${bookName}`;
        
        // Filter for this book (checking both formats)
        let bookData;
        if (objectStoreName === 'library' || objectStoreName === 'footnotes') {
            // For stores where book is the key, try both formats
            bookData = await new Promise((resolve) => {
                const request = store.get(bookNameWithoutSlash);
                request.onsuccess = () => {
                    if (request.result) {
                        resolve(request.result);
                    } else {
                        // Try with slash if first attempt failed
                        const request2 = store.get(bookNameWithSlash);
                        request2.onsuccess = () => resolve(request2.result);
                    }
                };
            });
        } else {
            // For stores with composite keys, filter with both formats
            bookData = allData.filter(item => 
                item.book === bookNameWithoutSlash || 
                item.book === bookNameWithSlash
            );
        }

        console.log(`📚 ${objectStoreName} data found:`, bookData);

        // If no data, return early
        if (!bookData || (Array.isArray(bookData) && bookData.length === 0)) {
            console.log(`ℹ️ No ${objectStoreName} data found for ${bookName}`);
            return {
                status: 'success',
                message: `No ${objectStoreName} data to sync`
            };
        }

        // Normalize the book ID format for sending to server
        const normalizedBookName = bookNameWithoutSlash;
        
        // ✅ ADD AUTH DATA HERE
        // Check if user is logged in
        const user = await getCurrentUser();
        
        // Prepare the request body with auth data
        const requestBody = {
            book: normalizedBookName,
            data: bookData
        };

        // Add auth data based on login status
        if (user) {
            // User is logged in - no need to add anonymous_token
            console.log(`🔐 Syncing as logged-in user: ${user.name}`);
        } else {
            // User is anonymous - add the UUID
            const anonId = getAuthorId();
            requestBody.anonymous_token = anonId;
            console.log(`🔐 Syncing as anonymous user: ${anonId}`);
        }

        console.log(`📤 Sending ${objectStoreName} data:`, requestBody);

        // Send to server
        const response = await fetch(storeConfig[objectStoreName].endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content
            },
            credentials: 'same-origin',
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Server error for ${objectStoreName}:`, errorText);
            throw new Error(errorText);
        }

        const result = await response.json();
        console.log(`✅ Success syncing ${objectStoreName}:`, result);
        return result;

    } catch (error) {
        console.error(`❌ Error syncing ${objectStoreName}:`, error);
        throw error;
    }
}



// get data from indexedDB, and send to backend for update
export async function syncIndexedDBtoPostgreSQL(bookName) {
  try {
    const results = await syncAllBookData(bookName); // Fixed parameter
    console.log("Sync succeeded:", results);
    return results;
  } catch (error) {
    console.error("Sync failed completely:", error);
    throw error; // Propagate error
  }
}


async function syncAllBookData(bookName) {
  console.log(`🔄 Starting sync for ${bookName}`);

  // 1) Upsert the library row first
  const libResult = await syncBookDataToServer(bookName, 'library');

  // 2) Once library exists, fire off the rest
  const [nc, hl, hc, fn] = await Promise.all([
    syncBookDataToServer(bookName, 'nodeChunks'),
    syncBookDataToServer(bookName, 'hyperlights'),
    syncBookDataToServer(bookName, 'hypercites'),
    syncBookDataToServer(bookName, 'footnotes'),
  ]);

  console.log('✅ All syncs completed:', {
    library: libResult,
    nodeChunks: nc,
    hyperlights: hl,
    hypercites: hc,
    footnotes: fn,
  });

  return { libResult, nc, hl, hc, fn };
}

async function syncAllBooksInLibrary(method = 'upsert') {
    console.log(`🔄 Starting sync for all books in library with method: ${method}`);
    
    try {
        // Open the database
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("MarkdownDB", 15);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        // Get all books from the library object store
        const tx = db.transaction(['library'], "readonly");
        const store = tx.objectStore('library');
        
        const allBooks = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        console.log(`📚 Found ${allBooks.length} books in library:`, allBooks);

        if (allBooks.length === 0) {
            console.log('ℹ️ No books found in library');
            return { status: 'success', message: 'No books to sync' };
        }

        // Extract book names from the 'book' property
        const bookNames = allBooks.map(book => book.book).filter(Boolean);

        console.log(`📋 Book names to sync:`, bookNames);

        // Sync each book sequentially (to avoid overwhelming the server)
        const results = [];
        for (const bookName of bookNames) {
            try {
                console.log(`🔄 Syncing book: ${bookName}`);
                const result = await syncAllBookData(bookName, method);
                results.push({ bookName, status: 'success', result });
                console.log(`✅ Successfully synced book: ${bookName}`);
            } catch (error) {
                console.error(`❌ Failed to sync book: ${bookName}`, error);
                results.push({ bookName, status: 'error', error: error.message });
            }
        }

        console.log('🎉 All books sync completed:', results);
        return results;

    } catch (error) {
        console.error('❌ Error getting books from library:', error);
        throw error;
    }
}

// Parallel version with the fix
async function syncAllBooksInLibraryParallel(method = 'upsert') {
    console.log(`🔄 Starting parallel sync for all books with method: ${method}`);
    
    try {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("MarkdownDB", 15);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        const tx = db.transaction(['library'], "readonly");
        const store = tx.objectStore('library');
        
        const allBooks = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        if (allBooks.length === 0) {
            return { status: 'success', message: 'No books to sync' };
        }

        // Fixed: use book.book instead of book.id
        const bookNames = allBooks.map(book => book.book).filter(Boolean);

        console.log(`📋 Book names to sync:`, bookNames);

        // Sync all books in parallel
        const syncPromises = bookNames.map(async (bookName) => {
            try {
                const result = await syncAllBookData(bookName, method);
                return { bookName, status: 'success', result };
            } catch (error) {
                return { bookName, status: 'error', error: error.message };
            }
        });

        const results = await Promise.all(syncPromises);
        console.log('🎉 All books parallel sync completed:', results);
        return results;

    } catch (error) {
        console.error('❌ Error in parallel sync:', error);
        throw error;
    }
}

// Updated helper function
async function getAllBookNamesFromLibrary() {
    try {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("MarkdownDB", 15);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        const tx = db.transaction(['library'], "readonly");
        const store = tx.objectStore('library');
        
        const allBooks = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        // Fixed: use book.book property
        const bookNames = allBooks.map(book => book.book).filter(Boolean);

        console.log('📚 All book names in library:', bookNames);
        return bookNames;

    } catch (error) {
        console.error('❌ Error getting book names:', error);
        throw error;
    }
}


function copyTheseToConsoleLog (doNotActuallyCallThis) {
// Sync everything with upsert
syncAllBookData("book_1748646769736", "upsert");

// Individual syncs with upsert
syncBookDataToServer("book_1748495788845", "hyperlights", "upsert");
syncBookDataToServer("book_1748495788845", "hypercites", "upsert");
syncBookDataToServer("book_1748495788845", "nodeChunks", "upsert");
syncBookDataToServer("book_1748495788845", "library", "upsert");
syncBookDataToServer("book_1748495788845", "footnotes", "upsert");


// Sync everything with bulk-create
syncAllBookData("book_1748495788845", "bulk-create");

// Individual syncs with bulk-create
syncBookDataToServer("book_1748495788845", "hyperlights", "bulk-create");
syncBookDataToServer("book_1748495788845", "hypercites", "bulk-create");
syncBookDataToServer("book_1748495788845", "nodeChunks", "bulk-create");
syncBookDataToServer("book_1748495788845", "library", "bulk-create");
syncBookDataToServer("book_1748495788845", "footnotes", "bulk-create");

}



/**
 * Sync complete book data from Laravel API to IndexedDB
 */
export async function syncBookDataFromDatabase(bookId) {
  console.log(`🔄 Starting database sync for: ${bookId}`);
   
  try {
    // 1. Fetch data from Laravel API
    console.log("📡 Fetching from API...");
    console.log(`📝 BookId type: ${typeof bookId}, value: "${bookId}"`); // This won't run if fetch fails
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/data`);

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`📚 Book "${bookId}" not found in database`);
        return { success: false, reason: 'book_not_found' };
      }
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log("✅ Data received from API:", {
      nodeChunks: data.nodeChunks.length,
      footnotes: data.footnotes ? 'Yes' : 'No',
      hyperlights: data.hyperlights.length,
      hypercites: data.hypercites.length,
      library: data.library ? 'Yes' : 'No'
    });
    
    // 2. Open IndexedDB
    const db = await openDatabase();
    
    // 3. Clear existing data for this book
    await clearBookDataFromIndexedDB(db, bookId);
    
    // 4. Load all data types into IndexedDB
    await Promise.all([
      loadNodeChunksToIndexedDB(db, data.nodeChunks),
      loadFootnotesToIndexedDB(db, data.footnotes),
      loadHyperlightsToIndexedDB(db, data.hyperlights),
      loadHypercitesToIndexedDB(db, data.hypercites),
      loadLibraryToIndexedDB(db, data.library)
    ]);
    
    console.log("🎉 Database sync completed successfully!");
    return {
      success: true,
      metadata: data.metadata,
      reason: 'synced_from_database'
    };
    
  } catch (error) {
    console.error("❌ Database sync failed:", error);
    return {
      success: false,
      error: error.message,
      reason: 'sync_error'
    };
  }
}



/**
 * Clear existing book data from IndexedDB
 */
async function clearBookDataFromIndexedDB(db, bookId) {
  console.log(`🧹 Clearing existing data for book: ${bookId}`);
  
  // Clear stores that have book-based indices
  const bookIndexedStores = ['nodeChunks', 'hyperlights', 'hypercites'];
  
  for (const storeName of bookIndexedStores) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const index = store.index('book');
    
    const keys = await new Promise((resolve, reject) => {
      const request = index.getAllKeys(bookId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    
    for (const key of keys) {
      await new Promise((resolve, reject) => {
        const deleteRequest = store.delete(key);
        deleteRequest.onsuccess = () => resolve();
        deleteRequest.onerror = () => reject(deleteRequest.error);
      });
    }
    
    console.log(`  ✅ Cleared ${keys.length} records from ${storeName}`);
  }
  
  // Clear single-record stores (footnotes uses book as primary key)
  const singleRecordStores = ['footnotes'];
  for (const storeName of singleRecordStores) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    
    try {
      await new Promise((resolve, reject) => {
        const deleteRequest = store.delete(bookId);
        deleteRequest.onsuccess = () => resolve();
        deleteRequest.onerror = () => reject(deleteRequest.error);
      });
      console.log(`  ✅ Cleared ${storeName} for book`);
    } catch (error) {
      console.log(`  ℹ️ No existing ${storeName} record to clear`);
    }
  }
  
  // Clear library (uses citationID as key, which should match bookId)
  try {
    const tx = db.transaction('library', 'readwrite');
    const store = tx.objectStore('library');
    
    await new Promise((resolve, reject) => {
      const deleteRequest = store.delete(bookId);
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
    });
    console.log(`  ✅ Cleared library for book`);
  } catch (error) {
    console.log(`  ℹ️ No existing library record to clear`);
  }
}

/**
 * Load node chunks into IndexedDB
 */
async function loadNodeChunksToIndexedDB(db, nodeChunks) {
  if (!nodeChunks || nodeChunks.length === 0) {
    console.log("ℹ️ No node chunks to load");
    return;
  }
  
  console.log(`📝 Loading ${nodeChunks.length} node chunks...`);
  
  const tx = db.transaction('nodeChunks', 'readwrite');
  const store = tx.objectStore('nodeChunks');
  
  for (const chunk of nodeChunks) {
    // ✅ Convert startLine AND parse JSON fields
    const processedChunk = {
      ...chunk,
      startLine: parseNodeId(chunk.startLine),
      // Parse JSON strings back to objects/arrays
      footnotes: typeof chunk.footnotes === 'string' ? JSON.parse(chunk.footnotes) : chunk.footnotes,
      hypercites: typeof chunk.hypercites === 'string' ? JSON.parse(chunk.hypercites) : chunk.hypercites,
      hyperlights: typeof chunk.hyperlights === 'string' ? JSON.parse(chunk.hyperlights) : chunk.hyperlights,
      raw_json: typeof chunk.raw_json === 'string' ? JSON.parse(chunk.raw_json) : chunk.raw_json
    };
    
    await new Promise((resolve, reject) => {
      const request = store.put(processedChunk);
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error("❌ Failed to store chunk:", processedChunk, request.error);
        reject(request.error);
      };
    });
  }
  
  console.log(`✅ Loaded ${nodeChunks.length} node chunks`);
}


/**
 * Load footnotes into IndexedDB
 */
async function loadFootnotesToIndexedDB(db, footnotes) {
  if (!footnotes) {
    console.log("ℹ️ No footnotes to load");
    return;
  }
  
  console.log("📝 Loading footnotes...");
  
  const tx = db.transaction('footnotes', 'readwrite');
  const store = tx.objectStore('footnotes');
  
  await new Promise((resolve, reject) => {
    const request = store.put(footnotes);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  
  console.log("✅ Loaded footnotes");
}

/**
 * Load hyperlights into IndexedDB
 */
async function loadHyperlightsToIndexedDB(db, hyperlights) {
  if (!hyperlights || hyperlights.length === 0) {
    console.log("ℹ️ No hyperlights to load");
    return;
  }
  
  console.log(`📝 Loading ${hyperlights.length} hyperlights...`);
  
  const tx = db.transaction('hyperlights', 'readwrite');
  const store = tx.objectStore('hyperlights');
  
  for (const hyperlight of hyperlights) {
    await new Promise((resolve, reject) => {
      const request = store.put(hyperlight);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  
  console.log(`✅ Loaded ${hyperlights.length} hyperlights`);
}

/**
 * Load hypercites into IndexedDB
 */
async function loadHypercitesToIndexedDB(db, hypercites) {
  if (!hypercites || hypercites.length === 0) {
    console.log("ℹ️ No hypercites to load");
    return;
  }
  
  console.log(`📝 Loading ${hypercites.length} hypercites...`);
  
  const tx = db.transaction('hypercites', 'readwrite');
  const store = tx.objectStore('hypercites');
  
  for (const hypercite of hypercites) {
    // Parse JSON strings back to objects/arrays
    const processedHypercite = {
      ...hypercite,
      citedIN: typeof hypercite.citedIN === 'string' ? JSON.parse(hypercite.citedIN) : hypercite.citedIN,
      raw_json: typeof hypercite.raw_json === 'string' ? JSON.parse(hypercite.raw_json) : hypercite.raw_json
    };
    
    await new Promise((resolve, reject) => {
      const request = store.put(processedHypercite);
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error("❌ Failed to store hypercite:", processedHypercite, request.error);
        reject(request.error);
      };
    });
  }
  
  console.log(`✅ Loaded ${hypercites.length} hypercites`);
}


/**
 * Load library data into IndexedDB
 */
async function loadLibraryToIndexedDB(db, library) {
  if (!library) {
    console.log("ℹ️ No library data to load");
    return;
  }
  
  console.log("📝 Loading library data...");
  
  const tx = db.transaction('library', 'readwrite');
  const store = tx.objectStore('library');
  
  await new Promise((resolve, reject) => {
    const request = store.put(library);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  
  console.log("✅ Loaded library data");
}














