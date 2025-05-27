import { openDatabase, parseNodeId } from "./cache-indexedDB.js";

async function syncBookDataToServer(bookName, objectStoreName) {
    // Configuration for different object stores
    const storeConfig = {
        nodeChunks: {
            endpoint: '/api/db/node-chunks/bulk-create',
            keyRange: IDBKeyRange.bound([bookName, 0], [bookName, Number.MAX_VALUE]),
            useCompositeKey: true
        },
        hyperlights: {
            endpoint: '/api/db/hyperlights/bulk-create',
            keyRange: IDBKeyRange.bound([bookName, ''], [bookName, '\uffff']),
            useCompositeKey: true
        },
        hypercites: {
            endpoint: '/api/db/hypercites/bulk-create',
            keyRange: IDBKeyRange.bound([bookName, ''], [bookName, '\uffff']),
            useCompositeKey: true
        },
        library: {
            endpoint: '/api/db/library/bulk-create',
            keyRange: IDBKeyRange.only(bookName),
            useCompositeKey: false
        },
        footnotes: {
            endpoint: '/api/db/footnotes/bulk-create',
            keyRange: IDBKeyRange.only(bookName),
            useCompositeKey: false
        }
    };

    // Validate object store name
    if (!storeConfig[objectStoreName]) {
        throw new Error(`Invalid object store name: ${objectStoreName}`);
    }

    const config = storeConfig[objectStoreName];

    try {
        // Open database
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("MarkdownDB", 13);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        // Get data from IndexedDB
        const data = await new Promise((resolve, reject) => {
            const transaction = db.transaction([objectStoreName], "readonly");
            const store = transaction.objectStore(objectStoreName);
            const request = config.useCompositeKey ? 
                store.getAll(config.keyRange) : 
                store.get(config.keyRange);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });

        // Log what we found
        console.log(`Found data in ${objectStoreName} for book: ${bookName}`, data);

        // Send to server
        const response = await fetch(config.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content
            },
            body: JSON.stringify({
                book: bookName,
                data: data
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            try {
                const errorJson = JSON.parse(errorText);
                throw new Error(JSON.stringify(errorJson));
            } catch(e) {
                throw new Error(errorText);
            }
        }

        const result = await response.json();
        console.log(`Success syncing ${objectStoreName}:`, result);
        return result;

    } catch (error) {
        console.error(`Error syncing ${objectStoreName}:`, error);
        throw error;
    }
}

// Usage examples:
async function syncAllBookData(bookName) {
    try {
        const results = await Promise.all([
            syncBookDataToServer(bookName, 'nodeChunks'),
            syncBookDataToServer(bookName, 'hyperlights'),
            syncBookDataToServer(bookName, 'hypercites'),
            syncBookDataToServer(bookName, 'library'),
            syncBookDataToServer(bookName, 'footnotes')
        ]);
        console.log('All syncs completed:', results);
    } catch (error) {
        console.error('Sync failed:', error);
    }
}

/* Or sync everything:

syncAllBookData("book_1748221302973");

// Use either individual sync:

syncBookDataToServer("Marx1867Capital", "footnotes");

*/



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
    // ✅ Convert startLine to proper numeric format (just like you do elsewhere)
    const processedChunk = {
      ...chunk,
      startLine: parseNodeId(chunk.startLine)  // This handles both "1.5" and 1.5
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
    await new Promise((resolve, reject) => {
      const request = store.put(hypercite);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
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














