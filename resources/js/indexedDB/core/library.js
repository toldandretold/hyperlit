/**
 * Library Management Module
 * Handles library metadata operations
 */

import { openDatabase } from './connection.js';
import { syncIndexedDBtoPostgreSQL } from '../../postgreSQL.js';
import { buildBibtexEntry } from '../../utilities/bibtexProcessor.js';

// Dependencies
let book, queueForSync;

// Initialization function to inject dependencies
export function initLibraryDependencies(deps) {
  book = deps.book;
  queueForSync = deps.queueForSync;
}

/**
 * Clean library item data before storing to prevent recursive nesting and oversized payloads
 * Mirrors the PHP cleanItemForStorage() logic in DbLibraryController.php
 *
 * This removes problematic fields that can cause:
 * 1. Recursive nesting (raw_json containing itself)
 * 2. Payload bloat (full_library_array)
 *
 * @param {Object} item - Library item to clean
 * @returns {Object} Cleaned library item
 */
export function cleanLibraryItemForStorage(item) {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const cleanItem = { ...item };

  // Remove raw_json to prevent recursive nesting
  delete cleanItem.raw_json;

  // Remove any other problematic nested fields that can cause payload bloat
  delete cleanItem.full_library_array;

  return cleanItem;
}

/**
 * Prepare library record for IndexedDB storage
 * Cleans the record and ensures raw_json is properly set
 *
 * @param {Object} libraryRecord - Library record to prepare
 * @returns {Object} Prepared library record
 */
export function prepareLibraryForIndexedDB(libraryRecord) {
  if (!libraryRecord || typeof libraryRecord !== 'object') {
    return libraryRecord;
  }

  // Clean the record
  const cleaned = cleanLibraryItemForStorage(libraryRecord);

  // Set raw_json to the cleaned version (as object, not string - IndexedDB stores it parsed)
  cleaned.raw_json = { ...cleaned };

  return cleaned;
}

/**
 * Get library object from IndexedDB for a specific book
 *
 * @param {string} book - Book identifier
 * @returns {Promise<Object|null>} Library object or null if not found
 */
export async function getLibraryObjectFromIndexedDB(book) {
  try {
    if (!book) {
      return null;
    }

    if (typeof book !== 'string' && typeof book !== 'number') {
      return null;
    }

    const db = await openDatabase();
    const tx = db.transaction(["library"], "readonly");
    const libraryStore = tx.objectStore("library");

    const getRequest = libraryStore.get(book);

    const libraryObject = await new Promise((resolve, reject) => {
      getRequest.onsuccess = (e) => {
        resolve(e.target.result);
      };
      getRequest.onerror = (e) => {
        console.error("❌ IndexedDB get request failed:", e.target.error);
        reject(e.target.error);
      };
    });

    return libraryObject;

  } catch (error) {
    console.error("❌ Error getting library object from IndexedDB:", error);
    return null;
  }
}

/**
 * Update the timestamp for a book in the library store
 * This triggers a sync of the library record to PostgreSQL
 *
 * @param {string} bookId - Book identifier
 * @returns {Promise<boolean>} Success status
 */
export async function updateBookTimestamp(bookId = book || "latest") {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const getRequest = store.get(bookId);

    return new Promise((resolve, reject) => {
      getRequest.onerror = (e) => {
        console.error("❌ Failed to get library record for timestamp update:", e.target.error);
        reject(e.target.error);
      };

      getRequest.onsuccess = () => {
        // ✅ STEP 1: Capture the original state BEFORE any modifications.
        // `structuredClone` creates a true, deep copy.
        const originalRecord = getRequest.result ? structuredClone(getRequest.result) : null;
        let recordToSave;

        if (getRequest.result) {
          // Now it's safe to modify the record we fetched.
          recordToSave = getRequest.result;
          recordToSave.timestamp = Date.now();
        } else {
          // If it's a new record, the original state is correctly `null`.
          recordToSave = {
            book: bookId,
            timestamp: Date.now(),
            title: bookId,
            description: "",
            tags: [],
          };
        }

        const putRequest = store.put(recordToSave);

        putRequest.onerror = (e) => {
          console.error("❌ Failed to put updated library record:", e.target.error);
          reject(e.target.error);
        };

        putRequest.onsuccess = () => {
          // 🔍 DIAGNOSTIC: Log when timestamp is updated locally
          console.log('🔍 TIMESTAMP UPDATE:', {
            bookId,
            newTimestamp: recordToSave.timestamp,
            action: 'local_update_queued_for_sync'
          });
          // ✅ STEP 2: Queue for sync, providing BOTH the new and original data.
          queueForSync("library", bookId, "update", recordToSave, originalRecord);
          resolve(true);
        };
      };
    });
  } catch (error) {
    console.error("❌ Failed to update book timestamp:", error);
    return false;
  }
}

/**
 * Sync the first node's text content to the library title
 * Only updates if title is still "Untitled"
 *
 * @param {string} bookId - Book identifier
 * @param {string} nodeContent - HTML content of the first node
 * @returns {Promise<boolean>} Success status
 */
export async function syncFirstNodeToTitle(bookId, nodeContent) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const getRequest = store.get(bookId);

    return new Promise((resolve, reject) => {
      getRequest.onerror = (e) => {
        console.error("❌ Failed to get library record for title sync:", e.target.error);
        reject(e.target.error);
      };

      getRequest.onsuccess = async () => {
        const libraryRecord = getRequest.result;

        // Only update if library record exists and title is "Untitled"
        if (!libraryRecord || libraryRecord.title !== "Untitled") {
          console.log(`ℹ️ Skipping title sync - title is not "Untitled" (current: "${libraryRecord?.title}")`);
          resolve(false);
          return;
        }

        // Extract text content from HTML (strip tags)
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = nodeContent;
        const textContent = tempDiv.textContent.trim();

        // Don't update if the text is empty or just whitespace
        if (!textContent) {
          console.log(`ℹ️ Skipping title sync - h1 content is empty`);
          resolve(false);
          return;
        }

        // Update the title
        libraryRecord.title = textContent;
        libraryRecord.timestamp = Date.now();

        // Set author if not already set (use creator username or "anon" for anonymous users)
        if (!libraryRecord.author) {
          if (libraryRecord.creator) {
            libraryRecord.author = libraryRecord.creator; // Use username
          } else if (libraryRecord.creator_token) {
            libraryRecord.author = "anon"; // Anonymous user
          }
          console.log(`✅ Auto-set author to: "${libraryRecord.author}"`);
        }

        // Regenerate bibtex to match new title and author
        libraryRecord.bibtex = buildBibtexEntry(libraryRecord);

        const putRequest = store.put(libraryRecord);

        putRequest.onerror = (e) => {
          console.error("❌ Failed to update library title:", e.target.error);
          reject(e.target.error);
        };

        putRequest.onsuccess = async () => {
          console.log(`✅ Auto-synced library: title="${textContent}", author="${libraryRecord.author}"`);

          // Queue for PostgreSQL sync
          queueForSync("library", bookId, "update", libraryRecord);

          resolve(true);
        };
      };
    });
  } catch (error) {
    console.error("❌ Failed to sync first node to title:", error);
    return false;
  }
}

/**
 * Update the annotations_updated_at timestamp for a book in IndexedDB.
 * Called after syncing annotations from server to keep local state in sync.
 *
 * @param {string} bookId - Book identifier
 * @param {number} timestamp - The new annotations_updated_at timestamp
 * @returns {Promise<boolean>} Success status
 */
export async function updateLocalAnnotationsTimestamp(bookId, timestamp) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const getRequest = store.get(bookId);

    return new Promise((resolve, reject) => {
      getRequest.onerror = (e) => {
        console.error("❌ Failed to get library record for annotations timestamp update:", e.target.error);
        reject(e.target.error);
      };

      getRequest.onsuccess = () => {
        const record = getRequest.result;

        if (!record) {
          console.warn(`⚠️ No library record found for ${bookId} when updating annotations timestamp`);
          resolve(false);
          return;
        }

        // Update only the annotations_updated_at field
        record.annotations_updated_at = timestamp;

        const putRequest = store.put(record);

        putRequest.onerror = (e) => {
          console.error("❌ Failed to update annotations timestamp:", e.target.error);
          reject(e.target.error);
        };

        putRequest.onsuccess = () => {
          console.log(`✅ Updated local annotations_updated_at for ${bookId}: ${timestamp}`);
          resolve(true);
        };
      };
    });
  } catch (error) {
    console.error("❌ Failed to update annotations timestamp:", error);
    return false;
  }
}

/**
 * Get all books that are available offline (have both library record AND nodes)
 * Used for homepage offline mode display
 *
 * @returns {Promise<Array>} Array of library records for offline-available books
 */
export async function getAllOfflineAvailableBooks() {
  try {
    const db = await openDatabase();

    // Get all library records
    const libraryRecords = await new Promise((resolve, reject) => {
      const tx = db.transaction("library", "readonly");
      const store = tx.objectStore("library");
      const request = store.getAll();
      request.onsuccess = () => {
        console.log(`📚 Library records found:`, request.result?.length || 0);
        resolve(request.result || []);
      };
      request.onerror = () => reject(request.error);
    });

    // Filter out special homepage books (these are virtual/generated)
    const specialBooks = ['most-recent', 'most-connected', 'most-lit'];
    const userBooks = libraryRecords.filter(r => r && r.book && !specialBooks.includes(r.book));
    console.log(`📚 User books (excluding special):`, userBooks.map(b => b.book));

    // Get all unique book IDs from nodes store
    const booksWithNodes = await new Promise((resolve, reject) => {
      const tx = db.transaction("nodes", "readonly");
      const store = tx.objectStore("nodes");
      const index = store.index("book");
      const bookIds = new Set();

      const cursorRequest = index.openKeyCursor();
      cursorRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          bookIds.add(cursor.key);
          cursor.continue();
        } else {
          console.log(`📄 Books with nodes in IndexedDB:`, [...bookIds]);
          resolve(bookIds);
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });

    // Filter to books that have both library record AND nodes
    const offlineBooks = userBooks.filter(lib => booksWithNodes.has(lib.book));

    // Sort by timestamp (most recent first)
    offlineBooks.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    console.log(`📱 Offline-available books:`, offlineBooks.map(b => b.book));
    return offlineBooks;

  } catch (error) {
    console.error('❌ Error getting offline books:', error);
    return [];
  }
}
