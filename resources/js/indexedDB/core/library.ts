/**
 * Library Management Module
 * Handles library metadata operations
 */

import { openDatabase } from './connection';
import { buildBibtexEntry } from '../../utilities/bibtexProcessor';
import { parseSubBookId } from '../../utilities/subBookIdHelper';

import { queueForSync } from '../syncQueue/queue';
import { log } from '../../utilities/logger';
import { LATEST, type BookId, type LibraryRecord } from '../types';
import type { ServerLibraryRow } from '../serverSync/types';

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
export function prepareLibraryForIndexedDB(
  libraryRecord: ServerLibraryRow | Partial<LibraryRecord>,
): LibraryRecord {
  if (!libraryRecord || typeof libraryRecord !== 'object') {
    return libraryRecord as LibraryRecord;
  }

  // Clean the record (wire row → store record)
  const cleaned = cleanLibraryItemForStorage(libraryRecord) as LibraryRecord & { raw_json?: unknown; timestamp?: number };

  // Set raw_json to the cleaned version (as object, not string - IndexedDB stores it parsed)
  cleaned.raw_json = { ...cleaned };

  // Ensure timestamp is never null — assign now if missing (the wire ServerLibraryRow allows null/0)
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
        log.error('IndexedDB get request failed', '/indexedDB/core/library.ts', getRequest.error);
        reject(getRequest.error);
      };
    });

    return libraryObject;

  } catch (error) {
    log.error('Error getting library object from IndexedDB', '/indexedDB/core/library.ts', error);
    return null;
  }
}

/**
 * Update the timestamp for a book (for content/node changes)
 */
export async function updateBookTimestamp(bookId: BookId = book || LATEST): Promise<boolean> {
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
          recordToSave = { book: bookId, timestamp: now, title: bookId };
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
    log.error('Failed to update book timestamp', '/indexedDB/core/library.ts', error);
    return false;
  }
}

/**
 * Update annotations_updated_at for a book (for highlight/hypercite changes)
 */
export async function updateAnnotationsTimestamp(bookId: BookId): Promise<boolean> {
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
          // Sub-books (footnote/highlight sub-books, id "book_X/FnY") have no
          // local library row — only real books do. Annotating inside one is a
          // normal action, so cascade the timestamp bump to the parent book's
          // row instead of erroring out and silently dropping the update.
          if (bookId.includes('/')) {
            const { foundation } = parseSubBookId(bookId);
            if (foundation && foundation !== bookId) {
              resolve(updateAnnotationsTimestamp(foundation as BookId));
              return;
            }
          }
          log.error(`No library record found for ${bookId}`, '/indexedDB/core/library.ts');
          resolve(false);
          return;
        }

        const originalRecord = structuredClone(record);
        record.annotations_updated_at = Date.now();

        const putRequest = store.put(record);
        putRequest.onerror = () => reject(putRequest.error);
        putRequest.onsuccess = () => {
          // Library timestamp updates are always side-effects, never clear redo history
          queueForSync("library", bookId, "update", record, originalRecord, true);
          resolve(true);
        };
      };
    });
  } catch (error) {
    log.error('Failed to update annotations timestamp', '/indexedDB/core/library.ts', error);
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
        log.error('Failed to get library record for title sync', '/indexedDB/core/library.ts', getRequest.error);
        reject(getRequest.error);
      };

      getRequest.onsuccess = async () => {
        const libraryRecord = getRequest.result as LibraryRecord | undefined;

        // Only update if library record exists and title is "Untitled"
        if (!libraryRecord || libraryRecord.title !== "Untitled") {
          resolve(false);
          return;
        }

        // Extract text content from HTML (strip tags)
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = nodeContent;
        const textContent = (tempDiv.textContent ?? '').trim();

        // Don't update if the text is empty or just whitespace
        if (!textContent) {
          resolve(false);
          return;
        }

        // Update the title
        libraryRecord.title = textContent;
        libraryRecord.timestamp = Date.now();

        // Set author from the creator username if not already set. (Anonymous books already get
        // author="anon" at creation in SPA/createNewBook.ts; the server never sends creator_token to
        // the client, so there's no anonymous signal to key off here.)
        if (!libraryRecord.author && libraryRecord.creator) {
          libraryRecord.author = libraryRecord.creator;
        }

        // Regenerate bibtex to match new title and author
        // (bibtexProcessor.js is untyped JS — its inferred param type is narrower than reality)
        libraryRecord.bibtex = buildBibtexEntry(libraryRecord as Parameters<typeof buildBibtexEntry>[0]);

        const putRequest = store.put(libraryRecord);

        putRequest.onerror = () => {
          log.error('Failed to update library title', '/indexedDB/core/library.ts', putRequest.error);
          reject(putRequest.error);
        };

        putRequest.onsuccess = async () => {
          // Queue for PostgreSQL sync - library updates never affect redo history
          queueForSync("library", bookId, "update", libraryRecord, null, true);

          resolve(true);
        };
      };
    });
  } catch (error) {
    log.error('Failed to sync first node to title', '/indexedDB/core/library.ts', error);
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
        log.error('Failed to get library record for annotations timestamp update', '/indexedDB/core/library.ts', getRequest.error);
        reject(getRequest.error);
      };

      getRequest.onsuccess = () => {
        const record = getRequest.result as LibraryRecord | undefined;

        if (!record) {
          log.error(`No library record found for ${bookId} when updating annotations timestamp`, '/indexedDB/core/library.ts');
          resolve(false);
          return;
        }

        // Update only the annotations_updated_at field
        record.annotations_updated_at = timestamp;

        const putRequest = store.put(record);

        putRequest.onerror = () => {
          log.error('Failed to update annotations timestamp', '/indexedDB/core/library.ts', putRequest.error);
          reject(putRequest.error);
        };

        putRequest.onsuccess = () => {
          resolve(true);
        };
      };
    });
  } catch (error) {
    log.error('Failed to update annotations timestamp', '/indexedDB/core/library.ts', error);
    return false;
  }
}

/**
 * Advance a book's client-only optimistic base (`base_timestamp`) to the server's CONFIRMED library
 * version, so the NEXT node sync compares against the version we just wrote — not a stale open-time
 * base — and doesn't false-409. Call this after ANY path that bumps the server's `library.timestamp`
 * (library upsert, AI-review re-sync, …); the unified node sync already does its own advance inline.
 *
 * Monotonic: it never LOWERS the base, so a stale/racy response can't drag it backwards and
 * re-introduce a false conflict. Best-effort — a failure here only warns, never breaks the caller.
 */
export async function advanceBaseTimestamp(bookId: BookId, confirmedTs: unknown): Promise<void> {
  const ts = Number(confirmedTs);
  if (!Number.isFinite(ts) || ts <= 0) return;
  try {
    const db = await openDatabase();
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const record = await new Promise<LibraryRecord | undefined>((resolve, reject) => {
      const req = store.get(bookId);
      req.onsuccess = () => resolve(req.result as LibraryRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!record) return;
    if (ts > (record.base_timestamp ?? 0)) {
      record.base_timestamp = ts;
      await new Promise<void>((resolve, reject) => {
        const put = store.put(record);
        put.onsuccess = () => resolve();
        put.onerror = () => reject(put.error);
      });
    }
  } catch (e) {
    log.error('Could not advance base_timestamp', '/indexedDB/core/library.ts', e);
  }
}

/**
 * Build the GET .../library API URL, splitting a sub-book id ("parentBook/subId", e.g.
 * "book_123/Fn456" or a deeper "book_123/2/HL_1/Fn_2") into the multi-segment route the
 * server exposes. A sub-book id in the single `{bookId}` slot NEVER matched a route:
 * `encodeURIComponent` turns the inner "/" into "%2F" which Symfony rejects, and a raw "/"
 * overflows the single segment — so every sub-book library fetch 404'd (the e2e "404 storm").
 * Mirrors initialChunk.ts buildApiUrl. Parent (no-slash) ids are unchanged.
 */
export function buildLibraryUrl(bookId: BookId): string {
  const id = String(bookId);
  const slash = id.indexOf('/');
  if (slash !== -1) {
    const parentBook = id.substring(0, slash);
    const subId = id.substring(slash + 1);
    return `/api/database-to-indexeddb/books/${parentBook}/${subId}/library`;
  }
  return `/api/database-to-indexeddb/books/${id}/library`;
}

/**
 * Fetch library record from server, returning both the record and whether the server was reached.
 * Lets callers distinguish "server confirmed no record" from "network failure".
 */
export async function fetchLibraryRecordWithStatus(
  bookId: BookId,
): Promise<{ record: LibraryRecord | null; serverReached: boolean }> {
  try {
    const response = await fetch(buildLibraryUrl(bookId), {
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
 * Works for both regular books and sub-books — buildLibraryUrl() routes sub-book ids to the
 * dedicated {parentBook}/{subId}/library route (a raw sub-book id in {bookId} 404s).
 */
export async function getLibraryRecordFromServer(bookId: BookId): Promise<LibraryRecord | null> {
  try {
    const response = await fetch(buildLibraryUrl(bookId), {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.success ? data.library : null;
  } catch (err) {
    log.error(`Failed to fetch library record for ${bookId}`, '/indexedDB/core/library.ts', err);
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
        resolve(request.result || []);
      };
      request.onerror = () => reject(request.error);
    });

    // Filter out special homepage books (these are virtual/generated)
    const specialBooks = ['most-recent', 'most-connected', 'most-lit'];
    const userBooks = libraryRecords.filter(r => r && r.book && !specialBooks.includes(r.book));

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
          resolve(bookIds);
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });

    // Filter to books that have both library record AND nodes
    const offlineBooks = userBooks.filter(lib => booksWithNodes.has(lib.book));

    // Sort by timestamp (most recent first)
    offlineBooks.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return offlineBooks;

  } catch (error) {
    log.error('Error getting offline books', '/indexedDB/core/library.ts', error);
    return [];
  }
}
