/**
 * Library Management Module
 * Handles library metadata operations
 */

import { openDatabase } from './connection';
import { buildBibtexEntry } from '../../utilities/bibtexProcessor';
import { parseSubBookId } from '../../utilities/subBookIdHelper';

import { queueForSync } from '../syncQueue/queue';
import type { BookId, LibraryRecord } from '../types';

// Dependencies that change per-book
let book: BookId | null | undefined;

// Initialization function to inject dependencies
export function initLibraryDependencies(deps: { book: BookId | null | undefined }): void {
  book = deps.book;
}

/**
 * Clean library item data before storing to prevent recursive nesting and oversized payloads
 * Mirrors the PHP cleanItemForStorage() logic in DbLibraryController.php
 *
 * This removes problematic fields that can cause:
 * 1. Recursive nesting (raw_json containing itself)
 * 2. Payload bloat (full_library_array)
 */
export function cleanLibraryItemForStorage<T>(item: T): T {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const cleanItem = { ...item } as T & { raw_json?: unknown; full_library_array?: unknown };

  // Remove raw_json to prevent recursive nesting
  delete cleanItem.raw_json;

  // Remove any other problematic nested fields that can cause payload bloat
  delete cleanItem.full_library_array;

  return cleanItem;
}

/**
 * Prepare library record for IndexedDB storage
 * Cleans the record and ensures raw_json is properly set
 */
export function prepareLibraryForIndexedDB<T extends Partial<LibraryRecord>>(libraryRecord: T): T {
  if (!libraryRecord || typeof libraryRecord !== 'object') {
    return libraryRecord;
  }

  // Clean the record
  const cleaned = cleanLibraryItemForStorage(libraryRecord) as T & { raw_json?: unknown; timestamp?: number };

  // Set raw_json to the cleaned version (as object, not string - IndexedDB stores it parsed)
  cleaned.raw_json = { ...cleaned };

  // Ensure timestamp is never null — assign now if missing
  if (!cleaned.timestamp) {
    cleaned.timestamp = Date.now();
  }

  return cleaned;
}

/**
 * Get library object from IndexedDB for a specific book
 */
export async function getLibraryObjectFromIndexedDB(book: unknown): Promise<LibraryRecord | null> {
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

    const getRequest = libraryStore.get(book as string);

    const libraryObject = await new Promise<LibraryRecord | null>((resolve, reject) => {
      getRequest.onsuccess = () => {
        resolve(getRequest.result ?? null);
      };
      getRequest.onerror = () => {
        console.error("❌ IndexedDB get request failed:", getRequest.error);
        reject(getRequest.error);
      };
    });

    return libraryObject;

  } catch (error) {
    console.error("❌ Error getting library object from IndexedDB:", error);
    return null;
  }
}

/**
 * Update the timestamp for a book (for content/node changes)
 */
export async function updateBookTimestamp(bookId: BookId = book || "latest"): Promise<boolean> {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const getRequest = store.get(bookId);

    return new Promise((resolve, reject) => {
      getRequest.onerror = () => reject(getRequest.error);

      getRequest.onsuccess = () => {
        const originalRecord = getRequest.result ? structuredClone(getRequest.result) : null;
        const now = Date.now();
        let recordToSave: LibraryRecord;

        if (getRequest.result) {
          recordToSave = getRequest.result;
          recordToSave.timestamp = now;
        } else {
          recordToSave = { book: bookId, timestamp: now, title: bookId, description: "", tags: [] };
        }

        const putRequest = store.put(recordToSave);
        putRequest.onerror = () => reject(putRequest.error);
        putRequest.onsuccess = () => {
          // Library timestamp updates are always side-effects, never clear redo history
          queueForSync("library", bookId, "update", recordToSave, originalRecord, true);

          // Sub-book → also update parent book
          // Footnote edits touch parent's content timestamp;
          // highlight annotation edits touch parent's annotations_updated_at
          if (bookId.includes('/')) {
            const { foundation, itemId } = parseSubBookId(bookId);
            if (itemId?.startsWith('HL_')) {
              updateAnnotationsTimestamp(foundation).catch(() => {});
            } else {
              // Footnotes (Fn*) and any other sub-book types → parent timestamp
              updateBookTimestamp(foundation).catch(() => {});
            }
          }

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
 * Update annotations_updated_at for a book (for highlight/hypercite changes)
 */
export async function updateAnnotationsTimestamp(bookId: BookId): Promise<boolean> {
  console.log(`📝 updateAnnotationsTimestamp called for: ${bookId}`);
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const getRequest = store.get(bookId);

    return new Promise((resolve, reject) => {
      getRequest.onerror = () => reject(getRequest.error);

      getRequest.onsuccess = () => {
        const record = getRequest.result as LibraryRecord | undefined;
        if (!record) {
          console.warn(`⚠️ No library record found for ${bookId}`);
          resolve(false);
          return;
        }

        const originalRecord = structuredClone(record);
        record.annotations_updated_at = Date.now();

        const putRequest = store.put(record);
        putRequest.onerror = () => reject(putRequest.error);
        putRequest.onsuccess = () => {
          console.log(`📝 Queuing library sync with annotations_updated_at: ${record.annotations_updated_at}`);
          // Library timestamp updates are always side-effects, never clear redo history
          queueForSync("library", bookId, "update", record, originalRecord, true);
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
 * Sync the first node's text content to the library title
 * Only updates if title is still "Untitled"
 */
export async function syncFirstNodeToTitle(bookId: BookId, nodeContent: string): Promise<boolean> {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const getRequest = store.get(bookId);

    return new Promise((resolve, reject) => {
      getRequest.onerror = () => {
        console.error("❌ Failed to get library record for title sync:", getRequest.error);
        reject(getRequest.error);
      };

      getRequest.onsuccess = async () => {
        const libraryRecord = getRequest.result as LibraryRecord | undefined;

        // Only update if library record exists and title is "Untitled"
        if (!libraryRecord || libraryRecord.title !== "Untitled") {
          console.log(`ℹ️ Skipping title sync - title is not "Untitled" (current: "${libraryRecord?.title}")`);
          resolve(false);
          return;
        }

        // Extract text content from HTML (strip tags)
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = nodeContent;
        const textContent = (tempDiv.textContent ?? '').trim();

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
        // (bibtexProcessor.js is untyped JS — its inferred param type is narrower than reality)
        libraryRecord.bibtex = buildBibtexEntry(libraryRecord as Parameters<typeof buildBibtexEntry>[0]);

        const putRequest = store.put(libraryRecord);

        putRequest.onerror = () => {
          console.error("❌ Failed to update library title:", putRequest.error);
          reject(putRequest.error);
        };

        putRequest.onsuccess = async () => {
          console.log(`✅ Auto-synced library: title="${textContent}", author="${libraryRecord.author}"`);

          // Queue for PostgreSQL sync - library updates never affect redo history
          queueForSync("library", bookId, "update", libraryRecord, null, true);

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
 * (Local bookkeeping only — does NOT queue a sync back to the server.)
 */
export async function updateLocalAnnotationsTimestamp(bookId: BookId, timestamp: number): Promise<boolean> {
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const getRequest = store.get(bookId);

    return new Promise((resolve, reject) => {
      getRequest.onerror = () => {
        console.error("❌ Failed to get library record for annotations timestamp update:", getRequest.error);
        reject(getRequest.error);
      };

      getRequest.onsuccess = () => {
        const record = getRequest.result as LibraryRecord | undefined;

        if (!record) {
          console.warn(`⚠️ No library record found for ${bookId} when updating annotations timestamp`);
          resolve(false);
          return;
        }

        // Update only the annotations_updated_at field
        record.annotations_updated_at = timestamp;

        const putRequest = store.put(record);

        putRequest.onerror = () => {
          console.error("❌ Failed to update annotations timestamp:", putRequest.error);
          reject(putRequest.error);
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
 * Fetch library record from server, returning both the record and whether the server was reached.
 * Lets callers distinguish "server confirmed no record" from "network failure".
 */
export async function fetchLibraryRecordWithStatus(
  bookId: BookId,
): Promise<{ record: LibraryRecord | null; serverReached: boolean }> {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${encodeURIComponent(bookId)}/library`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });
    if (response.ok) {
      const data = await response.json();
      return { record: data.success ? data.library : null, serverReached: true };
    }
    return { record: null, serverReached: true };   // 404, 403, etc. — server answered
  } catch (err) {
    return { record: null, serverReached: false };   // network error
  }
}

/**
 * Fetch library record from server API.
 * Works for both regular books and sub-books (server has route for both).
 */
export async function getLibraryRecordFromServer(bookId: BookId): Promise<LibraryRecord | null> {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.success ? data.library : null;
  } catch (err) {
    console.warn(`⚠️ Failed to fetch library record for ${bookId}:`, err);
    return null;
  }
}

/**
 * Get all books that are available offline (have both library record AND nodes)
 * Used for homepage offline mode display
 */
export async function getAllOfflineAvailableBooks(): Promise<LibraryRecord[]> {
  try {
    const db = await openDatabase();

    // Get all library records
    const libraryRecords = await new Promise<LibraryRecord[]>((resolve, reject) => {
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
    const booksWithNodes = await new Promise<Set<IDBValidKey>>((resolve, reject) => {
      const tx = db.transaction("nodes", "readonly");
      const store = tx.objectStore("nodes");
      const index = store.index("book");
      const bookIds = new Set<IDBValidKey>();

      const cursorRequest = index.openKeyCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
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
