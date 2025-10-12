// In historyManager.js

import { openDatabase } from "./indexedDB.js";
import { currentLazyLoader } from "./initializePage.js";
import { getEditToolbar } from "./editToolbar.js";

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
    return false;
  }
  const db = await openDatabase();
  const tx = db.transaction("historyLog", "readonly");
  const store = tx.objectStore("historyLog");

  return new Promise((resolve, reject) => {
    const request = store.openCursor(null, "prev"); // Start from most recent, go backwards

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.bookId === currentBookId) {
          // Found an entry for the current book. Undo IS possible.
          resolve(true); // Resolve immediately!
          return; // Stop processing the cursor
        }
        // If this entry is NOT for the current book, keep looking backwards.
        cursor.continue();
      } else {
        // No more entries, or none found for currentBookId.
        resolve(false); // Undo is NOT possible.
      }
    };
    request.onerror = (event) => {
      console.error("Error in canUndo:", event.target.error);
      reject(event.target.error);
    };
  });
}

export async function canRedo() {
  if (!currentBookId) {
    return false;
  }
  const db = await openDatabase();
  const tx = db.transaction("redoLog", "readonly");
  const store = tx.objectStore("redoLog");

  return new Promise((resolve, reject) => {
    const request = store.openCursor(null, "prev"); // Start from most recent, go backwards

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.bookId === currentBookId) {
          // Found an entry for the current book. Redo IS possible.
          resolve(true); // Resolve immediately!
          return; // Stop processing the cursor
        }
        // If this entry is NOT for the current book, keep looking backwards.
        cursor.continue();
      } else {
        // No more entries, or none found for currentBookId.
        resolve(false); // Redo is NOT possible.
      }
    };
    request.onerror = (event) => {
      console.error("Error in canRedo:", event.target.error);
      reject(event.target.error);
    };
  });
}




// In historyManager.js

export async function undoLastBatch() {
  const db = await openDatabase();
  const tx = db.transaction(
    ["historyLog", "redoLog", "nodeChunks", "hyperlights", "hypercites", "library"],
    "readwrite"
  );
  const historyStore = tx.objectStore("historyLog");
  const redoStore = tx.objectStore("redoLog");
  const chunksStore = tx.objectStore("nodeChunks");
  const lightsStore = tx.objectStore("hyperlights");
  const citesStore = tx.objectStore("hypercites");
  const libraryStore = tx.objectStore("library");

  const cursorReq = historyStore.openCursor(null, "prev");
  const cursor = await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => resolve(cursorReq.result);
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  if (!cursor || cursor.value.bookId !== currentBookId) {
    console.log("🌀 No history to undo for the current book.");
    tx.abort();
    return null; // Return null if there's nothing to do
  }

  const logToUndo = cursor.value;
  console.log(`⏪ Undoing batch ID: ${logToUndo.id}`);
  const targetId = getTargetIdFromPayload(logToUndo.payload);
  const { updates, deletions } = logToUndo.payload;

  // Revert operations
  for (const record of updates.nodeChunks || []) {
    chunksStore.delete([record.book, record.startLine]);
  }
  for (const record of updates.hyperlights || []) {
    lightsStore.delete([record.book, record.hyperlight_id]);
  }
  for (const record of updates.hypercites || []) {
    citesStore.delete([record.book, record.hyperciteId]);
  }
  if (updates.library) {
    libraryStore.delete(updates.library.book);
  }

  for (const record of deletions.nodeChunks || []) {
    chunksStore.put(record);
  }
  for (const record of deletions.hyperlights || []) {
    lightsStore.put(record);
  }
  for (const record of deletions.hypercites || []) {
    citesStore.put(record);
  }
  if (deletions.library) {
    libraryStore.put(deletions.library);
  }

  redoStore.add(logToUndo);
  cursor.delete();

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });

  console.log("✅ Undo DB operation complete. Returning target for refresh...");
  return targetId; // This is the ONLY thing that should be at the end
}

export async function redoLastBatch() {
  const db = await openDatabase();
  const tx = db.transaction(
    ["historyLog", "redoLog", "nodeChunks", "hyperlights", "hypercites", "library"],
    "readwrite"
  );
  const historyStore = tx.objectStore("historyLog");
  const redoStore = tx.objectStore("redoLog");
  const chunksStore = tx.objectStore("nodeChunks");
  const lightsStore = tx.objectStore("hyperlights");
  const citesStore = tx.objectStore("hypercites");

  const cursorReq = redoStore.openCursor(null, "prev");
  const cursor = await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => resolve(cursorReq.result);
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  if (!cursor || cursor.value.bookId !== currentBookId) {
    console.log("🌀 No history to redo for the current book.");
    tx.abort();
    return null; // Return null if there's nothing to do
  }

  const logToRedo = cursor.value;
  console.log(`⏩ Redoing batch ID: ${logToRedo.id}`);
  const targetId = getTargetIdFromPayload(logToRedo.payload);
  const { updates, deletions } = logToRedo.payload;

  // Re-apply operations
  for (const r of deletions.nodeChunks || []) {
    chunksStore.delete([r.book, r.startLine]);
  }
  for (const r of deletions.hyperlights || []) {
    lightsStore.delete([r.book, r.hyperlight_id]);
  }
  for (const r of deletions.hypercites || []) {
    citesStore.delete([r.book, r.hyperciteId]);
  }

  for (const record of updates.nodeChunks || []) {
    chunksStore.put(record);
  }
  for (const record of updates.hyperlights || []) {
    lightsStore.put(record);
  }
  for (const record of updates.hypercites || []) {
    citesStore.put(record);
  }

  historyStore.put(logToRedo);
  cursor.delete();

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });

  console.log("✅ Redo DB operation complete. Returning target for refresh...");
  return targetId; // This is the ONLY thing that should be at the end
}

export async function clearRedoHistory(bookId) {
  const db = await openDatabase();
  const tx = db.transaction(["redoLog"], "readwrite");
  const redoStore = tx.objectStore("redoLog");

  // We only need to clear entries for the specific book.
  // Using clear() is okay if you manage redo history per-book,
  // but a more robust way is to iterate and delete.
  // For simplicity, we'll stick with your current `clear()` but this is a note.
  await redoStore.clear();

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      console.log(
        `📝 New user action detected. Redo log cleared for book: ${bookId}.`
      );
      resolve();
    };
    tx.onerror = (event) => reject(event.target.error);
    tx.onabort = (event) =>
      reject(
        new Error(
          "Clear redo history transaction aborted: " + event.target.error
        )
      );
  });

  // ✅ NEW: Immediately update the button states after the transaction is complete.
 
}