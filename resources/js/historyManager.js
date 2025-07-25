import {
  openDatabase,
  // We no longer need to import the batch functions here
} from "./cache-indexedDB.js";

/**
 * Reads the last entry from the historyLog and attempts to revert the changes
 * within a single, unified IndexedDB transaction.
 */
export async function undoLastBatch() {
  const db = await openDatabase();
  // ✅ Start ONE transaction that includes ALL the stores we need to modify.
  const tx = db.transaction(
    ["historyLog", "nodeChunks", "hyperlights", "hypercites"],
    "readwrite"
  );
  const historyStore = tx.objectStore("historyLog");
  const chunksStore = tx.objectStore("nodeChunks");
  const lightsStore = tx.objectStore("hyperlights");
  const citesStore = tx.objectStore("hypercites");

  // Use a cursor to get the very last item in the store
  const cursor = await new Promise((resolve, reject) => {
    const request = historyStore.openCursor(null, "prev");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!cursor) {
    console.log("🌀 No history to undo.");
    // We must explicitly abort if we do nothing, otherwise the transaction hangs.
    tx.abort();
    return;
  }

  const lastLogEntry = cursor.value;
  console.log(`⏪ Undoing batch ID: ${lastLogEntry.id}`, lastLogEntry);

  const { updates, deletions } = lastLogEntry.payload;

  // --- 1. Restore Deletions ---
  const recordsToRestore = [
    ...(deletions.nodeChunks || []),
    ...(deletions.hyperlights || []),
    ...(deletions.hypercites || []),
  ];

  if (recordsToRestore.length > 0) {
    console.log("Restoring deleted records:", recordsToRestore);
    // ✅ Perform the restoration within our active transaction
    recordsToRestore.forEach((record) => {
      // This is a simplified check. You might need to check the object structure
      // to know which store to put it in.
      if (record.hasOwnProperty("startLine")) {
        chunksStore.put(record);
      } else if (record.hasOwnProperty("hyperlight_id")) {
        // lightsStore.put(record);
      }
    });
  }

  // --- 2. Revert Updates & Creations ---
  if (updates.nodeChunks && updates.nodeChunks.length > 0) {
    const idsToDelete = updates.nodeChunks.map((record) => [
      record.book,
      record.startLine,
    ]);
    console.log(`Reverting created/updated nodes by deleting them...`);
    // ✅ Perform the deletion within our active transaction
    idsToDelete.forEach((key) => {
      chunksStore.delete(key);
    });
  }

  // --- 3. Finalize the Undo ---
  // ✅ This will now work because the transaction is still active.
  console.log(`Deleting historyLog entry ${lastLogEntry.id}...`);
  cursor.delete();

  // Wait for the single, unified transaction to complete.
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
    tx.onabort = (event) => reject(event.target.error);
  });

  console.log("✅ Undo complete. Reloading page to reflect changes.");
  window.location.reload();
}