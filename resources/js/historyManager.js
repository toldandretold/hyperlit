// In historyManager.js

import { openDatabase } from "./cache-indexedDB.js";
import { currentLazyLoader } from "./initializePage.js";

// Private module-level variable to store the current book ID
let currentBookId = null;

// Function to set the current book ID when a new book is loaded
export function setCurrentBookId(bookId) {
  currentBookId = bookId;
  console.log(`History Manager: Current book ID set to ${currentBookId}`);
  // IMPORTANT: When book ID changes, we should ideally clear redo history for that book
  // or at least make sure redo only applies to the correct book context.
  // For simplicity, for now, we'll just check for entries for the current book.
}

// ✅ NEW: Helper function to find the primary target ID from a log payload
function getTargetIdFromPayload(payload) {
  const { updates, deletions } = payload;
  // Prioritize deletions, as that's where the content was.
  if (deletions.nodeChunks && deletions.nodeChunks.length > 0) {
    return deletions.nodeChunks[0].startLine;
  }
  // If no deletions, use the first updated item.
  if (updates.nodeChunks && updates.nodeChunks.length > 0) {
    return updates.nodeChunks[0].startLine;
  }
  return null; // No clear target
}

/**
 * Checks if there are any history entries for the current book that can be undone.
 * @returns {Promise<boolean>} True if undo is possible, false otherwise.
 */
export async function canUndo() {
  if (!currentBookId) {
    return false; // No book loaded, no history to undo
  }
  const db = await openDatabase();
  const tx = db.transaction("historyLog", "readonly");
  const store = tx.objectStore("historyLog");

  // Use a cursor to find if any entry matches the current bookId
  const request = store.openCursor(null, "prev");
  let hasHistory = false;

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        // Assuming your history log entries have a 'bookId' property
        if (cursor.value.bookId === currentBookId) {
          hasHistory = true;
          cursor.continue(); // Continue to find if there are multiple, or just break if one is enough
        } else {
          // If the entry doesn't match, we still need to continue
          cursor.continue();
        }
      } else {
        // No more entries or none found matching
        resolve(hasHistory);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Checks if there are any redo entries for the current book that can be redone.
 * @returns {Promise<boolean>} True if redo is possible, false otherwise.
 */
export async function canRedo() {
  if (!currentBookId) {
    return false; // No book loaded, no redo history
  }
  const db = await openDatabase();
  const tx = db.transaction("redoLog", "readonly");
  const store = tx.objectStore("redoLog");

  // Use a cursor to find if any entry matches the current bookId
  const request = store.openCursor(null, "prev");
  let hasRedo = false;

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        // Assuming your redo log entries also have a 'bookId' property
        if (cursor.value.bookId === currentBookId) {
          hasRedo = true;
          cursor.continue();
        } else {
          cursor.continue();
        }
      } else {
        resolve(hasRedo);
      }
    };
    request.onerror = () => reject(request.error);
  });
}
export async function undoLastBatch() {
  const db = await openDatabase();
  const tx = db.transaction(
    ["historyLog", "redoLog", "nodeChunks", "hyperlights", "hypercites"],
    "readwrite"
  );
  const historyStore = tx.objectStore("historyLog");
  const redoStore = tx.objectStore("redoLog");
  const chunksStore = tx.objectStore("nodeChunks");
  const lightsStore = tx.objectStore("hyperlights");
  const citesStore = tx.objectStore("hypercites");

  const cursor = await new Promise((resolve, reject) => {
    const request = historyStore.openCursor(null, "prev"); // Get the most recent
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!cursor || cursor.value.bookId !== currentBookId) {
    console.log("🌀 No history to undo for the current book.");
    tx.abort();
    return; // No history or history for a different book
  }

  const logToUndo = cursor.value;
  console.log(`⏪ Undoing batch ID: ${logToUndo.id} for book ${logToUndo.bookId}`, logToUndo);

  const targetId = getTargetIdFromPayload(logToUndo.payload);
  const { updates, deletions } = logToUndo.payload;

  // Revert operations: Delete what was updated, add what was deleted
  if (updates.nodeChunks && updates.nodeChunks.length > 0) {
    const idsToDelete = updates.nodeChunks.map((r) => [r.book, r.startLine]);
    idsToDelete.forEach((key) => chunksStore.delete(key));
  }
  if (updates.hyperlights && updates.hyperlights.length > 0) {
    const idsToDelete = updates.hyperlights.map((r) => [r.book, r.hyperlight_id]);
    idsToDelete.forEach((key) => lightsStore.delete(key));
  }
  if (updates.hypercites && updates.hypercites.length > 0) {
    const idsToDelete = updates.hypercites.map((r) => [r.book, r.hyperciteId]);
    idsToDelete.forEach((key) => citesStore.delete(key));
  }

  if (deletions.nodeChunks && deletions.nodeChunks.length > 0) {
    deletions.nodeChunks.forEach((record) => chunksStore.put(record));
  }
  if (deletions.hyperlights && deletions.hyperlights.length > 0) {
    deletions.hyperlights.forEach((record) => lightsStore.put(record));
  }
  if (deletions.hypercites && deletions.hypercites.length > 0) {
    deletions.hypercites.forEach((record) => citesStore.put(record));
  }


  // Move the log entry to the redoLog
  redoStore.add(logToUndo);
  cursor.delete(); // Delete from historyLog

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });

  console.log("✅ Undo complete. Refreshing content...");
  if (currentLazyLoader) {
    await currentLazyLoader.refresh(targetId);
  } else {
    window.location.reload();
  }
}


export async function redoLastBatch() {
  const db = await openDatabase();
  const tx = db.transaction(
    ["historyLog", "redoLog", "nodeChunks", "hyperlights", "hypercites"],
    "readwrite"
  );
  const historyStore = tx.objectStore("historyLog");
  const redoStore = tx.objectStore("redoLog");
  const chunksStore = tx.objectStore("nodeChunks");
  const lightsStore = tx.objectStore("hyperlights");
  const citesStore = tx.objectStore("hypercites");

  const cursor = await new Promise((resolve, reject) => {
    const request = redoStore.openCursor(null, "prev"); // Get the most recent
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!cursor || cursor.value.bookId !== currentBookId) {
    console.log("🌀 No history to redo for the current book.");
    tx.abort();
    return; // No redo history or history for a different book
  }

  const logToRedo = cursor.value;
  console.log(`⏩ Redoing batch ID: ${logToRedo.id} for book ${logToRedo.bookId}`, logToRedo);

  const targetId = getTargetIdFromPayload(logToRedo.payload);
  const { updates, deletions } = logToRedo.payload;

  // Re-apply operations: Delete what was deleted, add what was updated
  if (deletions.nodeChunks && deletions.nodeChunks.length > 0) {
    const keysToDelete = deletions.nodeChunks.map((r) => [r.book, r.startLine]);
    keysToDelete.forEach((key) => chunksStore.delete(key));
  }
  if (deletions.hyperlights && deletions.hyperlights.length > 0) {
    const keysToDelete = deletions.hyperlights.map((r) => [r.book, r.hyperlight_id]);
    keysToDelete.forEach((key) => lightsStore.delete(key));
  }
  if (deletions.hypercites && deletions.hypercites.length > 0) {
    const keysToDelete = deletions.hypercites.map((r) => [r.book, r.hyperciteId]);
    keysToDelete.forEach((key) => citesStore.delete(key));
  }

  if (updates.nodeChunks && updates.nodeChunks.length > 0) {
    updates.nodeChunks.forEach((record) => chunksStore.put(record));
  }
  if (updates.hyperlights && updates.hyperlights.length > 0) {
    updates.hyperlights.forEach((record) => lightsStore.put(record));
  }
  if (updates.hypercites && updates.hypercites.length > 0) {
    updates.hypercites.forEach((record) => citesStore.put(record));
  }

  // Move the log entry back to the historyLog
  historyStore.add(logToRedo);
  cursor.delete(); // Delete from redoLog

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });

  console.log("✅ Redo complete. Refreshing content...");
  if (currentLazyLoader) {
    await currentLazyLoader.refresh(targetId);
  } else {
    window.location.reload();
  }
}


// This function needs to be called by your updateIndexedDBRecord and batchUpdateIndexedDBRecords
// whenever a change that should be undoable occurs.
export async function addHistoryBatch(bookId, payload) {
  const db = await openDatabase();
  const tx = db.transaction(["historyLog", "redoLog"], "readwrite");
  const historyStore = tx.objectStore("historyLog");
  const redoStore = tx.objectStore("redoLog");

  const timestamp = Date.now();
  const newLogEntry = {
    id: `log-${timestamp}`, // Unique ID for the log entry
    bookId: bookId, // Associate with the current book
    timestamp: timestamp,
    payload: payload,
  };

  // Add to history log
  await historyStore.add(newLogEntry);

  // THIS IS THE CRUCIAL FIX: Clear redo log whenever a new history entry is added
  // because adding a new action invalidates future 'redo' operations
  await redoStore.clear(); // <--- ADD THIS LINE HERE

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      console.log(`📝 History batch added: ${newLogEntry.id}. Redo log cleared.`);
      resolve();
    };
    tx.onerror = (event) => reject(event.target.error);
  });
}