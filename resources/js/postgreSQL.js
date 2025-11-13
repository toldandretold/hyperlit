import { openDatabase, parseNodeId, prepareLibraryForIndexedDB } from "./indexedDB/index.js";
import { getCurrentUser, getAuthorId } from "./utilities/auth.js";
import { log, verbose } from './utilities/logger.js';

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

    verbose.content(`Sync attempt for ${objectStoreName} from window/tab ${window.name || 'unnamed'}`, 'postgreSQL.js');

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

        verbose.content(`${objectStoreName} total records: ${allData.length}`, 'postgreSQL.js');

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

        verbose.content(`${objectStoreName} data found: ${bookData ? JSON.stringify(bookData).substring(0, 100) + '...' : 'none'}`, 'postgreSQL.js');

        // If no data, return early
        if (!bookData || (Array.isArray(bookData) && bookData.length === 0)) {
            verbose.content(`No ${objectStoreName} data found for ${bookName}`, 'postgreSQL.js');
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

        verbose.content(`Sending ${objectStoreName} data to server`, 'postgreSQL.js');

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
        verbose.content(`Success syncing ${objectStoreName}`, 'postgreSQL.js');
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
  verbose.content(`Starting sync for ${bookName}`, 'postgreSQL.js');

  // 1) Upsert the library row first
  const libResult = await syncBookDataToServer(bookName, 'library');

  // 2) Once library exists, fire off the rest
  const [nc, hl, hc, fn] = await Promise.all([
    syncBookDataToServer(bookName, 'nodeChunks'),
    syncBookDataToServer(bookName, 'hyperlights'),
    syncBookDataToServer(bookName, 'hypercites'),
    syncBookDataToServer(bookName, 'footnotes'),
  ]);

  verbose.content('All syncs completed', 'postgreSQL.js');

  return { libResult, nc, hl, hc, fn };
}

async function syncAllBooksInLibrary(method = 'upsert') {
    verbose.content(`Starting sync for all books in library with method: ${method}`, 'postgreSQL.js');

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

        verbose.content(`Found ${allBooks.length} books in library`, 'postgreSQL.js');

        if (allBooks.length === 0) {
            verbose.content('No books found in library', 'postgreSQL.js');
            return { status: 'success', message: 'No books to sync' };
        }

        // Extract book names from the 'book' property
        const bookNames = allBooks.map(book => book.book).filter(Boolean);

        verbose.content(`Book names to sync: ${bookNames.join(', ')}`, 'postgreSQL.js');

        // Sync each book sequentially (to avoid overwhelming the server)
        const results = [];
        for (const bookName of bookNames) {
            try {
                verbose.content(`Syncing book: ${bookName}`, 'postgreSQL.js');
                const result = await syncAllBookData(bookName, method);
                results.push({ bookName, status: 'success', result });
                verbose.content(`Successfully synced book: ${bookName}`, 'postgreSQL.js');
            } catch (error) {
                console.error(`❌ Failed to sync book: ${bookName}`, error);
                results.push({ bookName, status: 'error', error: error.message });
            }
        }

        verbose.content('All books sync completed', 'postgreSQL.js');
        return results;

    } catch (error) {
        console.error('❌ Error getting books from library:', error);
        throw error;
    }
}

// Parallel version with the fix
async function syncAllBooksInLibraryParallel(method = 'upsert') {
    verbose.content(`Starting parallel sync for all books with method: ${method}`, 'postgreSQL.js');

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

        verbose.content(`Book names to sync: ${bookNames.join(', ')}`, 'postgreSQL.js');

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
        verbose.content('All books parallel sync completed', 'postgreSQL.js');
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

        verbose.content(`All book names in library: ${bookNames.join(', ')}`, 'postgreSQL.js');
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
  verbose.content(`Starting database sync for: ${bookId}`, 'postgreSQL.js');

  try {
    // 1. Fetch data from Laravel API
    verbose.content('Making API request', 'postgreSQL.js');

    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/data`);

    verbose.content(`API response received: ${response.status}`, 'postgreSQL.js');

    if (!response.ok) {
      if (response.status === 404) {
        verbose.content(`Book "${bookId}" not found in database - this is normal for new books`, 'postgreSQL.js');
        return { success: false, reason: 'book_not_found' };
      }

      // 🔒 Handle private book access denied
      if (response.status === 403) {
        const errorData = await response.json();
        verbose.content(`Access denied to book "${bookId}"`, 'postgreSQL.js');

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
    verbose.content(`Data received: ${data.nodeChunks?.length || 0} nodes, ${data.hyperlights?.length || 0} highlights`, 'postgreSQL.js');

    // 2. Open IndexedDB
    verbose.content('Opening IndexedDB', 'postgreSQL.js');
    const db = await openDatabase();

    // 3. Clear existing data for this book
    verbose.content('Clearing existing data for this book', 'postgreSQL.js');
    await clearBookDataFromIndexedDB(db, bookId);

    // 4. Load all data types into IndexedDB
    verbose.content('Loading all data types into IndexedDB', 'postgreSQL.js');
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
      if (result.status === 'rejected') {
        console.error(`❌ ${loadTypes[index]} failed to load:`, result.reason);
      }
    });

    // Check if any loads failed
    const failures = loadResults.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(`❌ ${failures.length} data types failed to load`, failures);
      throw new Error(`Failed to load ${failures.length} data types into IndexedDB`);
    }

    log.content('Database sync completed', 'postgreSQL.js');

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
  verbose.content(`Clearing existing data for book: ${bookId}`, 'postgreSQL.js');

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

    verbose.content(`Cleared ${keys.length} records from ${storeName}`, 'postgreSQL.js');
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
      verbose.content(`Cleared ${storeName} for book`, 'postgreSQL.js');
    } catch (error) {
      verbose.content(`No existing ${storeName} record to clear`, 'postgreSQL.js');
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
    verbose.content('Cleared library for book', 'postgreSQL.js');
  } catch (error) {
    verbose.content('No existing library record to clear', 'postgreSQL.js');
  }
}

/**
 * Load node chunks into IndexedDB
 */
async function loadNodeChunksToIndexedDB(db, nodeChunks) {
  if (!nodeChunks || nodeChunks.length === 0) {
    verbose.content('No nodes to load', 'postgreSQL.js');
    return;
  }

  verbose.content(`Loading ${nodeChunks.length} nodes`, 'postgreSQL.js');

  const tx = db.transaction('nodeChunks', 'readwrite');
  const store = tx.objectStore('nodeChunks');

  let chunksWithHighlights = 0;
  let totalEmbeddedHighlights = 0;
  let userHighlightCount = 0;

  for (const [chunkIndex, chunk] of nodeChunks.entries()) {
    // ✅ Convert startLine AND parse JSON fields
    let parsedHyperlights = null;
    if (chunk.hyperlights) {
      try {
        parsedHyperlights = typeof chunk.hyperlights === 'string' ?
          JSON.parse(chunk.hyperlights) : chunk.hyperlights;

        if (parsedHyperlights && parsedHyperlights.length > 0) {
          chunksWithHighlights++;
          totalEmbeddedHighlights += parsedHyperlights.length;

          // Count user highlights
          const userHighlightsInChunk = parsedHyperlights.filter(h => h.is_user_highlight);
          userHighlightCount += userHighlightsInChunk.length;
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

  verbose.content(`Loaded ${nodeChunks.length} nodes (${chunksWithHighlights} with highlights, ${userHighlightCount} user highlights)`, 'postgreSQL.js');
}


/**
 * Load footnotes into IndexedDB
 */
async function loadFootnotesToIndexedDB(db, footnotes) {
  if (!footnotes || !footnotes.data) {
    verbose.content('No footnotes to load', 'postgreSQL.js');
    return;
  }

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

  verbose.content(`Loaded ${Object.keys(footnotesData).length} footnotes`, 'postgreSQL.js');
}

/**
 * Load bibliography/references into IndexedDB
 */
async function loadBibliographyToIndexedDB(db, bibliography) {
  if (!bibliography || !bibliography.data) {
    verbose.content('No bibliography to load', 'postgreSQL.js');
    return;
  }

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

  verbose.content(`Loaded ${Object.keys(bibliographyData).length} references`, 'postgreSQL.js');
}

/**
 * Load hyperlights into IndexedDB
 */
async function loadHyperlightsToIndexedDB(db, hyperlights) {
  if (!hyperlights || hyperlights.length === 0) {
    verbose.content('No hyperlights to load', 'postgreSQL.js');
    return;
  }

  verbose.content(`Loading ${hyperlights.length} standalone hyperlights`, 'postgreSQL.js');

  const tx = db.transaction('hyperlights', 'readwrite');
  const store = tx.objectStore('hyperlights');

  let userHighlightCount = 0;
  let anonHighlightCount = 0;

  // Analyze highlights before storing
  hyperlights.forEach((highlight) => {
    const isUserHighlight = highlight.is_user_highlight;
    if (isUserHighlight) {
      userHighlightCount++;
    } else {
      anonHighlightCount++;
    }
  });

  for (const hyperlight of hyperlights) {
    await new Promise((resolve, reject) => {
      const request = store.put(hyperlight);
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error('❌ Failed to store standalone highlight:', hyperlight, request.error);
        reject(request.error);
      };
    });
  }

  verbose.content(`Loaded ${hyperlights.length} standalone hyperlights (${userHighlightCount} user, ${anonHighlightCount} anonymous)`, 'postgreSQL.js');
}

/**
 * Load hypercites into IndexedDB
 */
async function loadHypercitesToIndexedDB(db, hypercites) {
  if (!hypercites || hypercites.length === 0) {
    verbose.content('No hypercites to load', 'postgreSQL.js');
    return;
  }

  verbose.content(`Loading ${hypercites.length} hypercites`, 'postgreSQL.js');

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

  verbose.content(`Loaded ${hypercites.length} hypercites`, 'postgreSQL.js');
}


/**
 * Load library data into IndexedDB
 */
async function loadLibraryToIndexedDB(db, library) {
  if (!library) {
    verbose.content('No library data to load', 'postgreSQL.js');
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

  verbose.content('Loaded library data (cleaned)', 'postgreSQL.js');
}
