import { openDatabase, parseNodeId, prepareLibraryForIndexedDB } from "./indexedDB.js";
import { getCurrentUser, getAuthorId } from "./utilities/auth.js";

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
            const request = indexedDB.open("MarkdownDB", 21);
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
            bookData = await new Promise((resolve) => {
                const request = store.get(bookNameWithoutSlash);
                request.onsuccess = () => {
                    if (request.result) {
                        resolve(request.result);
                    } else {
                        const request2 = store.get(bookNameWithSlash);
                        request2.onsuccess = () => resolve(request2.result);
                    }
                };
            });
        } else {
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
        
        // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
        const requestBody = {
            book: normalizedBookName,
            data: bookData
        };

        console.log(`📤 Sending ${objectStoreName} data:`, requestBody);

        // Send to server - credentials: 'include' ensures cookies are sent
        const response = await fetch(storeConfig[objectStoreName].endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content
            },
            credentials: 'include', // This sends the anon_token cookie
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
  console.log(`🔄 Starting database sync for: ${bookId}`, {
    bookId_type: typeof bookId,
    bookId_value: bookId,
    timestamp: new Date().toISOString()
  });
   
  try {
    // 1. Fetch data from Laravel API
    console.log("📡 Making API request...", {
      endpoint: `/api/database-to-indexeddb/books/${bookId}/data`,
      method: 'GET'
    });
    
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/data`);
    
    console.log("📡 API response received:", {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: {
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length')
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`📚 Book "${bookId}" not found in database - this is normal for new books`);
        return { success: false, reason: 'book_not_found' };
      }

      // 🔒 Handle private book access denied
      if (response.status === 403) {
        const errorData = await response.json();
        console.log(`🔒 Access denied to book "${bookId}"`, errorData);

        if (errorData.error === 'access_denied') {
          // Import handlePrivateBookAccessDenied function
          const { handlePrivateBookAccessDenied } = await import('./initializePage.js');
          await handlePrivateBookAccessDenied(bookId);
          return { success: false, reason: 'access_denied' };
        }
      }

      const errorText = await response.text();
      console.error(`❌ API request failed:`, {
        status: response.status,
        statusText: response.statusText,
        errorText
      });
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log("🔍 RAW API RESPONSE - first highlight:", data.hyperlights[0]);
    console.log("🔍 is_user_highlight in API response:", data.hyperlights[0]?.is_user_highlight);
    
    const metadataForLogging = { ...data.metadata };
    if (Object.prototype.hasOwnProperty.call(metadataForLogging, 'total_chunks')) {
        metadataForLogging.total_nodes = metadataForLogging.total_chunks;
        delete metadataForLogging.total_chunks;
    }
    console.log("✅ Data received from API - detailed breakdown:", {
      nodeChunks: {
        count: data.nodeChunks?.length || 0,
        sample: data.nodeChunks?.length > 0 ? {
          first_chunk: {
            chunk_id: data.nodeChunks[0].chunk_id,
            startLine: data.nodeChunks[0].startLine,
            has_hyperlights: !!(data.nodeChunks[0].hyperlights),
            hyperlights_count: data.nodeChunks[0].hyperlights ? 
              (typeof data.nodeChunks[0].hyperlights === 'string' ? 
                JSON.parse(data.nodeChunks[0].hyperlights).length : 
                data.nodeChunks[0].hyperlights.length) : 0
          }
        } : null
      },
      hyperlights: {
        count: data.hyperlights?.length || 0,
        sample: data.hyperlights?.length > 0 ? {
          first_highlight: {
            id: data.hyperlights[0].hyperlight_id,
            is_user_highlight: data.hyperlights[0].is_user_highlight,
            creator: data.hyperlights[0].creator,
            creator_token: data.hyperlights[0].creator_token,
            startChar: data.hyperlights[0].startChar,
            endChar: data.hyperlights[0].endChar
          }
        } : null
      },
      hypercites: {
        count: data.hypercites?.length || 0
      },
      footnotes: data.footnotes ? 'Yes' : 'No',
      bibliography: data.bibliography ? 'Yes' : 'No',
      library: data.library ? 'Yes' : 'No',
      metadata: data.metadata
    });
    
    // 2. Open IndexedDB
    console.log("🗃️ Opening IndexedDB...");
    const db = await openDatabase();
    console.log("✅ IndexedDB opened successfully");
    
    // 3. Clear existing data for this book
    console.log("🧹 Clearing existing data for this book...");
    await clearBookDataFromIndexedDB(db, bookId);
    console.log("✅ Existing data cleared");
    
    // 4. Load all data types into IndexedDB
    console.log("📥 Loading all data types into IndexedDB...");
    const loadResults = await Promise.allSettled([
      loadNodeChunksToIndexedDB(db, data.nodeChunks),
      loadFootnotesToIndexedDB(db, data.footnotes),
      loadBibliographyToIndexedDB(db, data.bibliography),
      loadHyperlightsToIndexedDB(db, data.hyperlights),
      loadHypercitesToIndexedDB(db, data.hypercites),
      loadLibraryToIndexedDB(db, data.library)
    ]);
    
    // Log results of each load operation
    const loadTypes = ['nodeChunks', 'footnotes', 'bibliography', 'hyperlights', 'hypercites', 'library'];
    loadResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        console.log(`✅ ${loadTypes[index]} loaded successfully`);
      } else {
        console.error(`❌ ${loadTypes[index]} failed to load:`, result.reason);
      }
    });
    
    // Check if any loads failed
    const failures = loadResults.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(`❌ ${failures.length} data types failed to load`, failures);
      throw new Error(`Failed to load ${failures.length} data types into IndexedDB`);
    }
    
    console.log("🎉 Database sync completed successfully!", {
      bookId,
      loaded_types: loadTypes.length,
      success_count: loadResults.filter(r => r.status === 'fulfilled').length
    });
    
    return {
      success: true,
      metadata: data.metadata,
      reason: 'synced_from_database',
      loaded_counts: {
        nodeChunks: data.nodeChunks?.length || 0,
        hyperlights: data.hyperlights?.length || 0,
        hypercites: data.hypercites?.length || 0
      }
    };
    
  } catch (error) {
    console.error("❌ Database sync failed:", {
      bookId,
      error: error.message,
      stack: error.stack
    });
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
    console.log("ℹ️ No nodes to load into nodeChunks object store in IndexedDB from node_chunks table in PostgreSQL");
    return;
  }

  console.log(`📝 Loading ${nodeChunks.length} nodes into nodeChunks object store in IndexedDB from node_chunks table in PostgreSQL...`);
  
  const tx = db.transaction('nodeChunks', 'readwrite');
  const store = tx.objectStore('nodeChunks');
  
  let chunksWithHighlights = 0;
  let totalEmbeddedHighlights = 0;
  let userHighlightCount = 0;
  
  for (const [chunkIndex, chunk] of nodeChunks.entries()) {
     /* console.log(`📝 Processing chunk ${chunkIndex + 1}/${nodeChunks.length}`, {
      chunk_id: chunk.chunk_id,
      startLine: chunk.startLine,
      startLine_type: typeof chunk.startLine,
      has_hyperlights: !!(chunk.hyperlights),
      hyperlights_type: typeof chunk.hyperlights
    }); */
    
    // ✅ Convert startLine AND parse JSON fields
    let parsedHyperlights = null;
    if (chunk.hyperlights) {
      try {
        parsedHyperlights = typeof chunk.hyperlights === 'string' ? 
          JSON.parse(chunk.hyperlights) : chunk.hyperlights;
        
        if (parsedHyperlights && parsedHyperlights.length > 0) {
          chunksWithHighlights++;
          totalEmbeddedHighlights += parsedHyperlights.length;
          
          console.log(`📝 Chunk ${chunkIndex + 1} contains ${parsedHyperlights.length} embedded highlights:`, 
            parsedHyperlights.map(h => ({
              id: h.hyperlight_id || h.highlightID,
              is_user_highlight: h.is_user_highlight,
              creator: h.creator,
              creator_token: h.creator_token,
              startChar: h.startChar || h.charStart,
              endChar: h.endChar || h.charEnd
            }))
          );
          
          // Count user highlights
          const userHighlightsInChunk = parsedHyperlights.filter(h => h.is_user_highlight);
          userHighlightCount += userHighlightsInChunk.length;
          
          if (userHighlightsInChunk.length > 0) {
            console.log(`✅ Chunk ${chunkIndex + 1} has ${userHighlightsInChunk.length} user highlights`);
          }
        }
      } catch (parseError) {
        console.error(`❌ Error parsing hyperlights for chunk ${chunkIndex + 1}:`, parseError, chunk.hyperlights);
        parsedHyperlights = [];
      }
    }
    
    const processedChunk = {
      ...chunk,
      startLine: parseNodeId(chunk.startLine),
      // Parse JSON strings back to objects/arrays
      footnotes: typeof chunk.footnotes === 'string' ? 
        (chunk.footnotes ? JSON.parse(chunk.footnotes) : null) : chunk.footnotes,
      hypercites: typeof chunk.hypercites === 'string' ? 
        (chunk.hypercites ? JSON.parse(chunk.hypercites) : null) : chunk.hypercites,
      hyperlights: parsedHyperlights,
      raw_json: typeof chunk.raw_json === 'string' ? 
        (chunk.raw_json ? JSON.parse(chunk.raw_json) : null) : chunk.raw_json
    };
    
    await new Promise((resolve, reject) => {
      const request = store.put(processedChunk);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        console.error(`❌ Failed to store chunk ${chunkIndex + 1}:`, processedChunk, request.error);
        reject(request.error);
      };
    });
  }
  
  console.log(`✅ Loaded ${nodeChunks.length} nodes into nodeChunks object store in IndexedDB from node_chunks table in PostgreSQL - Summary:`, {
    total_nodes: nodeChunks.length,
    chunks_with_highlights: chunksWithHighlights,
    total_embedded_highlights: totalEmbeddedHighlights,
    user_highlights_in_chunks: userHighlightCount
  });
}


/**
 * Load footnotes into IndexedDB
 */
async function loadFootnotesToIndexedDB(db, footnotes) {
  if (!footnotes || !footnotes.data) {
    console.log("ℹ️ No footnotes to load");
    return;
  }
  
  console.log("📝 Loading footnotes...");
  
  const tx = db.transaction('footnotes', 'readwrite');
  const store = tx.objectStore('footnotes');
  
  // Convert footnotes.data object to individual records
  const footnotesData = footnotes.data;
  const promises = [];
  
  for (const [footnoteId, content] of Object.entries(footnotesData)) {
    const record = {
      book: footnotes.book,
      footnoteId: footnoteId,
      content: content
    };
    
    promises.push(new Promise((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }));
  }
  
  await Promise.all(promises);
  
  console.log(`✅ Loaded ${Object.keys(footnotesData).length} footnotes`);
}

/**
 * Load bibliography/references into IndexedDB
 */
async function loadBibliographyToIndexedDB(db, bibliography) {
  if (!bibliography || !bibliography.data) {
    console.log("ℹ️ No bibliography to load");
    return;
  }
  
  console.log("📚 Loading bibliography...");
  
  const tx = db.transaction('references', 'readwrite');
  const store = tx.objectStore('references');
  
  // Convert bibliography.data object to individual records
  const bibliographyData = bibliography.data;
  const promises = [];
  
  for (const [referenceId, content] of Object.entries(bibliographyData)) {
    const record = {
      book: bibliography.book,
      referenceId: referenceId,
      content: content
    };
    
    promises.push(new Promise((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }));
  }
  
  await Promise.all(promises);
  
  console.log(`✅ Loaded ${Object.keys(bibliographyData).length} references`);
}

/**
 * Load hyperlights into IndexedDB
 */
async function loadHyperlightsToIndexedDB(db, hyperlights) {
  if (!hyperlights || hyperlights.length === 0) {
    console.log("ℹ️ No hyperlights to load");
    return;
  }
  
  console.log(`📝 Loading ${hyperlights.length} standalone hyperlights into hyperlights object store in IndexedDB from hyperlights table in PostgreSQL...`);

  const tx = db.transaction('hyperlights', 'readwrite');
  const store = tx.objectStore('hyperlights');
  
  let userHighlightCount = 0;
  let anonHighlightCount = 0;
  
  // Analyze highlights before storing
  console.log("📝 Analyzing standalone highlights:");
  hyperlights.forEach((highlight, index) => {
    const isUserHighlight = highlight.is_user_highlight;
    if (isUserHighlight) {
      userHighlightCount++;
    } else {
      anonHighlightCount++;
    }
    
    console.log(`  Highlight ${index + 1}:`, {
      id: highlight.hyperlight_id,
      is_user_highlight: highlight.is_user_highlight,
      creator: highlight.creator,
      creator_token: highlight.creator_token,
      startChar: highlight.startChar,
      endChar: highlight.endChar,
      text_length: highlight.endChar - highlight.startChar
    });
  });
  
  console.log(`📝 Standalone highlight breakdown:`, {
    total: hyperlights.length,
    user_highlights: userHighlightCount,
    anonymous_highlights: anonHighlightCount
  });
  
  for (const [highlightIndex, hyperlight] of hyperlights.entries()) {
    console.log(`📝 Storing standalone highlight ${highlightIndex + 1}/${hyperlights.length}`, {
      id: hyperlight.hyperlight_id,
      is_user_highlight: hyperlight.is_user_highlight
    });
    
    console.log("🔍 STORING highlight to IndexedDB:", hyperlight);
    console.log("🔍 is_user_highlight being stored:", hyperlight.is_user_highlight);
    
    await new Promise((resolve, reject) => {
      const request = store.put(hyperlight);
      request.onsuccess = () => {
        console.log(`✅ Successfully stored standalone highlight ${highlightIndex + 1}`);
        resolve();
      };
      request.onerror = () => {
        console.error(`❌ Failed to store standalone highlight ${highlightIndex + 1}:`, hyperlight, request.error);
        reject(request.error);
      };
    });
  }
  
  console.log(`✅ Loaded ${hyperlights.length} standalone hyperlights into hyperlights object store in IndexedDB from hyperlights table in PostgreSQL - Summary:`, {
    total: hyperlights.length,
    user_highlights: userHighlightCount,
    anonymous_highlights: anonHighlightCount
  });
}

/**
 * Load hypercites into IndexedDB
 */
async function loadHypercitesToIndexedDB(db, hypercites) {
  if (!hypercites || hypercites.length === 0) {
    console.log("ℹ️ No hypercites to load");
    return;
  }
  
  console.log(`📝 Loading ${hypercites.length} hypercites into hypercites object store in IndexedDB from hypercites table in PostgreSQL...`);

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

  console.log(`✅ Loaded ${hypercites.length} hypercites into hypercites object store in IndexedDB from hypercites table in PostgreSQL`);
}


/**
 * Load library data into IndexedDB
 */
async function loadLibraryToIndexedDB(db, library) {
  if (!library) {
    console.log("ℹ️ No library data to load");
    return;
  }

  // 🧹 Clean the library data from PostgreSQL to remove any corrupted/bloated fields
  // This prevents corrupted data from propagating into IndexedDB
  const cleanedLibrary = prepareLibraryForIndexedDB(library);

  const tx = db.transaction('library', 'readwrite');
  const store = tx.objectStore('library');

  await new Promise((resolve, reject) => {
    const request = store.put(cleanedLibrary);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  console.log("✅ Loaded library data (cleaned)");
}
