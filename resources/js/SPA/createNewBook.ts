import { asBookId } from "../indexedDB/types";
const API_BASE_URL = window.location.origin;

// createNewBook.js (Corrected and Optimized)
import {
  openDatabase,
  updateBookTimestamp,
  addNewBookToIndexedDB,
  syncNodesToPostgreSQL,
} from "../indexedDB/index.js";
import { buildBibtexEntry } from "../utilities/bibtexProcessor";
import { syncIndexedDBtoPostgreSQL } from "../indexedDB/serverSync/index";
import { getCurrentUser, getAnonymousToken } from "../utilities/auth/index";
import { generateDataNodeId } from "../utilities/IDfunctions";
import { queueForSync } from "../indexedDB/syncQueue/queue";
import { log } from "../utilities/logger";
import { setPendingNewBook, clearPendingNewBook } from "../utilities/pendingNewBook";



// Helper remains the same
function generateUUID() {
  return (([1e7] as any) + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: any) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (c / 4)))
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
  bookId: any,
  isNewBook = false,
  payload: any = null
) {
  // This function now returns a promise that resolves when the critical sync is done.
  return new Promise<void>(async (resolve, reject) => {
    try {
      // Store the sync start time to avoid overwriting newer local changes
      const syncStartTime = Date.now();
      // A NEW book's library row goes out on the bulk-create call below (it re-reads
      // the freshly-bumped row from IndexedDB), so queuing the bump for the sync
      // pipeline as well would POST the identical row a second time — a node-less
      // unified-sync that drains ~3s later, i.e. after the handshake has settled and
      // straight into the user's first edits. See updateBookTimestamp's note for what
      // that stray drain breaks. A failed create still re-queues both the library row
      // and the nodes via queueNewBookForRetry, so nothing loses its retry path.
      await updateBookTimestamp(bookId, { queueSync: !isNewBook });

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
          const currentLocal: any = await new Promise<any>((resolve, reject) => {
            const req = store.get(bookId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          
          // Don't overwrite changes made after sync started
          if (currentLocal && currentLocal.timestamp > syncStartTime) {
            console.log("🔄 Local changes detected after sync started - preserving all local changes");
            // ...but STILL adopt the server's confirmed base_timestamp. base_timestamp is the
            // optimistic-concurrency token, NOT content — leaving it frozen at createdAt while the
            // server stored the bumped create-sync timestamp makes the VERY FIRST edit after
            // creating a book falsely 409 (STALE_DATA) → hard-block. This branch (fast editor,
            // currentLocal.timestamp > syncStartTime) subsumes the "local newer" branch below, so
            // without this the base is never adopted. Content untouched (spread); monotonic.
            const adoptedBase = Math.max(currentLocal.base_timestamp ?? 0, syncResult.library.timestamp ?? 0);
            if (adoptedBase !== currentLocal.base_timestamp) {
              await new Promise<void>((res, rej) => {
                const put = store.put({ ...currentLocal, base_timestamp: adoptedBase });
                put.onsuccess = () => res();
                put.onerror = () => rej(put.error);
              });
            }
            // Book's library row is now on the server and the base is adopted → it's settled;
            // stop skipping the base-check for it (also un-suppresses new-book overlays).
            clearPendingNewBook(bookId);
            resolve(); // Skip server CONTENT updates (local content is newer)
            return;
          }
          
          if (currentLocal && currentLocal.timestamp > syncResult.library.timestamp) {
            // Local record has been modified since sync started - preserve local changes
            console.log("🔄 Local record is newer - preserving local changes and updating server fields only");

            // Update only server-specific fields while preserving local content changes
            // 🔒 SECURITY: creator_token is no longer returned by server (security fix)
            // Keep local creator_token, update creator and is_owner from server
            const mergedRecord = {
              ...currentLocal, // Keep local changes (title, timestamp, etc.) including creator_token
              creator: syncResult.library.creator, // Update server ownership fields
              is_owner: syncResult.library.is_owner ?? currentLocal.is_owner, // Preserve local if server doesn't include it
              updated_at: syncResult.library.updated_at,
              created_at: syncResult.library.created_at,
              // Advance the concurrency base to the server's confirmed version even when local
              // CONTENT is newer — base_timestamp tracks server acknowledgement, not local edits.
              // Without this it stays frozen at createdAt while the server moved to its sync-time
              // timestamp, so the VERY FIRST edit after creating a book falsely 409s (STALE_DATA)
              // and pops the "you edited a stale version" hard-block. Monotonic — never lowers it.
              base_timestamp: Math.max(currentLocal.base_timestamp ?? 0, syncResult.library.timestamp ?? 0),
            };
            
            await store.put(mergedRecord);
            console.log("✅ Local library record updated with server ownership, local changes preserved.");
          } else {
            // No local changes, safe to use server data
            // 🔒 SECURITY: Preserve local creator_token since server no longer returns it
            const serverData = {
              ...syncResult.library,
              creator_token: currentLocal?.creator_token || syncResult.library.creator_token,
              is_owner: syncResult.library.is_owner ?? currentLocal?.is_owner,
              // The server record carries no client-only base_timestamp; freeze it at the server's
              // version we're adopting (mirror the pull path) so it isn't dropped → no false 409.
              base_timestamp: syncResult.library.timestamp,
            };
            console.log("✅ No local changes detected - using server data");
            await store.put(serverData);
            console.log("✅ Local library record updated with server data.");
          }

          // Wait for transaction to complete using proper IndexedDB API
          await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }

        // The library row exists on the server → the handshake has done its job and
        // every gated consumer may proceed. Resolve BEFORE the node sync (which is
        // not part of "the book exists"), but hand that tail its OWN error handling:
        // after resolve(), `reject` below is a no-op, so a failure there used to
        // vanish completely.
        resolve();

        try {
          await syncNodesForNewBook(bookId, payload?.nodes, syncStartTime);
          // New book fully settled on the server (library + nodes) → clear the pending marker so the
          // base-check skip / overlay suppression don't leak for the rest of the tab's life.
          clearPendingNewBook(bookId);
          console.log(`[Background Sync] Successfully synced new book: ${bookId}`);
        } catch (nodeErr) {
          // Post-resolve: nobody is listening on this promise any more, so queue the
          // content through the NORMAL sync path instead of dropping it. (Logged as a
          // failure — this tail used to fall through to the "Successfully synced" line.)
          queueNewBookForRetry(bookId, payload, nodeErr);
        }
      } else {
        // For existing books, the sync is the whole operation.
        await syncIndexedDBtoPostgreSQL(bookId);
        resolve();
        console.log(`[Background Sync] Successfully synced existing book: ${bookId}`);
      }
    } catch (err) {
      console.error(`[Background Sync] Failed for book: ${bookId}`, err);
      // Hand the book to the ordinary sync queue so the debounced masterSync retries
      // it (and historyLog + retryFailedBatches back that up). The server self-heals a
      // missing library row on the unified-sync path — UnifiedSyncController calls
      // SubBookRegistrar::ensureLibraryRecords before upserting nodes — so a failed
      // bulk-create is recoverable through the same machinery as every other failure.
      queueNewBookForRetry(bookId, payload, err);
      reject(err); // The caller (trackNewBookEstablishment) turns this into a result.
    }
  });
}

/**
 * Re-queue a new book whose create handshake failed, through the ONE retry path
 * the rest of the app uses.
 *
 * This replaces `storeFallbackSync`, which wrote to a `failedSyncs` object store
 * that the schema never created (so it always hit its own "store not found" warn
 * and returned) and that nothing ever read. Two dead ends pretending to be a
 * safety net: every failed create logged a line and evaporated.
 */
function queueNewBookForRetry(bookId: any, payload: any, error: unknown): void {
  log.error(
    `New book "${bookId}" did not settle on the server — re-queued for the normal sync`,
    '/SPA/createNewBook.ts',
    error,
  );
  // Each item is queued independently: one bad record must not drop the rest.
  // (queueForSync arms the debounced drain itself — no explicit kick needed.)
  const items: Array<[() => void, string]> = [];
  if (payload?.libraryRecord) {
    items.push([() => queueForSync('library', bookId, 'update', payload.libraryRecord, null, true), 'library row']);
  }
  for (const node of payload?.nodes ?? []) {
    items.push([() => queueForSync('nodes', node.startLine, 'update', node, null, true), `node ${node.startLine}`]);
  }
  for (const [queueIt, what] of items) {
    try {
      queueIt();
    } catch (queueError) {
      log.error(`Could not re-queue ${what} for "${bookId}"`, '/SPA/createNewBook.ts', queueError);
    }
  }
}

/**
 * Sync a new book to PostgreSQL using bulk-create endpoint
 * @param {string} bookId
 * @param {object} [libraryData] - Optional pre-fetched library record
 */
// In createNewBook.js

async function syncNewBookToPostgreSQL(bookId: any, libraryData: any = null) {
  try {
    let libraryRecord;

    // Prefer fresh data from IndexedDB over stale sessionStorage snapshot
    try {
      const db = await openDatabase();
      const tx = db.transaction(["library"], "readonly");
      const store = tx.objectStore("library");
      const freshRecord = await new Promise<any>((resolve, reject) => {
        const req = store.get(bookId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      if (freshRecord) {
        libraryRecord = freshRecord;
      }
    } catch (e) {
      console.warn("Failed to read fresh library from IndexedDB, using snapshot:", e);
    }

    // Fall back to sessionStorage snapshot if IndexedDB doesn't have the record
    if (!libraryRecord) {
      libraryRecord = libraryData;
    }

    if (!libraryRecord) {
      throw new Error(`Library record not found for book: ${bookId}`);
    }

    // E2EE seam (docs/e2ee.md): a born-encrypted book's metadata leaves the
    // client as ciphertext even on this direct bulk-create call (which bypasses
    // the sync-queue seams).
    let wireRecord = libraryRecord;
    if (libraryRecord?.encrypted) {
      const { encryptStoreRows } = await import("../e2ee/transform");
      [wireRecord] = await encryptStoreRows("library", bookId, [libraryRecord]);
    }

    const payload = {
      book: bookId,
      data: wireRecord,
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
            (document.querySelector('meta[name="csrf-token"]') as any)?.content,
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
    const bookId = asBookId("book_" + Date.now());

    // Get current user to set author field
    const user = await getCurrentUser();
    const username = user?.username || null;
    const anonToken = username ? null : await getAnonymousToken();

    // A locally-created book is never pulled from the server, so freeze its optimistic-concurrency
    // base at creation (= its own starting version). Without this, the sync layer falls back to the
    // CLIMBING `timestamp` as the base, which lets concurrent drains sample different values and
    // 409 falsely. See LibraryRecord.base_timestamp and syncQueue/master.ts.
    const createdAt = Date.now();
    const newLibraryRecord: any = {
      book: bookId,
      title: "Untitled",
      author: username || (anonToken ? "anon" : null), // Use username, or "anon" if anonymous
      type: "book",
      // A book authored right now really is published this year, so the year
      // is set HERE, on the record, rather than invented inside
      // buildBibtexEntry — which used to stamp the current year onto every
      // entry it built, including regenerations for books imported years
      // earlier (that is how a 2024 article rendered as "(2026)").
      year: String(new Date().getFullYear()),
      timestamp: createdAt,
      base_timestamp: createdAt,
      creator: username,
      creator_token: anonToken,
      visibility: "private",
      is_owner: true, // You're always the owner of a book you just created
    };
    newLibraryRecord.bibtex = buildBibtexEntry(newLibraryRecord);

    // E2EE (docs/e2ee.md): born-encrypted book. The flag is set by the newBook
    // button ONLY after it verified the vault is unlocked, so DEK creation here
    // can't hit a locked vault in the normal flow (and if it somehow does, we
    // fail the CREATE rather than silently making a plaintext book).
    if (sessionStorage.getItem("pending_new_book_encrypted") === "1") {
      sessionStorage.removeItem("pending_new_book_encrypted");
      const { createDekForBook } = await import("../e2ee/keys");
      const { setBookEncrypted } = await import("../e2ee/registry");
      const { wrappedDek } = await createDekForBook(bookId);
      newLibraryRecord.encrypted = true;
      newLibraryRecord.wrapped_dek = wrappedDek;
      setBookEncrypted(bookId, true);
    }

    // Generate node_id for the initial H1 element
    const initialNodeId = generateDataNodeId(bookId);

    const initialNode = {
      book: bookId,
      startLine: 100,
      chunk_id: 0,
      content: `<h1 id="100" data-node-id="${initialNodeId}"><br></h1>`,
      node_id: initialNodeId,
      hyperlights: [],
      hypercites: [],
    };

    const tx = db.transaction(["library", "nodes"], "readwrite");
    tx.objectStore("library").put(newLibraryRecord);
    await addNewBookToIndexedDB(
      initialNode.book,
      initialNode.startLine,
      initialNode.content,
      initialNode.chunk_id,
      tx,
    );

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e: any) => reject(e.target.error);
    });

    // ✅ THE CHANGE: Create the full data object here.
    const pendingSyncData = {
      bookId: bookId,
      isNewBook: true,
      libraryRecord: newLibraryRecord,
      nodes: [initialNode],
    };

    // Reload-recovery record (utilities/pendingNewBook): if the user refreshes
    // before the create lands, readerEntry re-sends this payload.
    setPendingNewBook(pendingSyncData);

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
 * Retrieve and sync nodes for a new book
 * @param {string} bookId
 * @param {Array<object>} [chunksData] - Optional pre-fetched nodes
 */
async function syncNodesForNewBook(bookId: any, chunksData: any = null, syncStartTime: any = null) {
  try {
    // Check if book content was modified after sync started by checking library timestamp
    if (syncStartTime) {
      console.log("🔍 Checking library timestamp to detect if content was modified after sync started...");
      const db = await openDatabase();
      const tx = db.transaction(["library"], "readonly");
      const libraryRecord: any = await new Promise<any>((resolve, reject) => {
        const req = tx.objectStore("library").get(bookId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      // Wait for transaction to complete using proper IndexedDB API
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      if (libraryRecord && libraryRecord.timestamp > syncStartTime) {
        console.log("🔄 Book content has been modified after sync started - skipping node sync to preserve local changes", {
          syncStartTime,
          libraryTimestamp: libraryRecord.timestamp
        });
        return { success: true, message: "Nodes sync skipped - local changes detected" };
      }
    }

    // Always read current data from IndexedDB to avoid stale sync
    console.log("📚 Reading current nodes from IndexedDB to avoid syncing stale data...");
    const db = await openDatabase();
    const tx = db.transaction(["nodes"], "readonly");
    const index = tx.objectStore("nodes").index("book");
    const currentNodes: any = await index.getAll(bookId);

    // Wait for transaction to complete using proper IndexedDB API
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    if (currentNodes.length === 0) {
      console.log("No nodes to sync for book:", bookId);
      return { success: true, message: "No nodes to sync" };
    }

    console.log(
      `📤 Calling syncNodesToPostgreSQL with ${currentNodes.length} current chunks`
    );
    return await syncNodesToPostgreSQL(bookId, currentNodes);
  } catch (error) {
    console.error("❌ Error in syncNodesForNewBook:", error);
    throw error;
  }
}

// NOTE: this file used to end with its own `online` listener calling a
// `retryFailedSyncs()` that read the `failedSyncs` store — a second, parallel
// retry system whose store the schema never created, so both ends were no-ops
// ("✅ No failedSyncs store found, nothing to retry"). The real one is
// pageLoad/onlineRetry.ts: it replays historyLog on boot AND on `online`, and
// queueNewBookForRetry (above) now feeds failed creates into that same path.