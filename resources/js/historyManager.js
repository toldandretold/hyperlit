import {
  openDatabase,
  batchUpdateIndexedDBRecords
} from "./cache-indexedDB.js";
import { currentLazyLoader } from "./initializePage.js";

/**
 * Reads the last entry from the historyLog and attempts to revert the changes
 * within a single, unified IndexedDB transaction.
 */
// In historyManager.js

export async function undoLastBatch() {
  const db = await openDatabase();
  // ✅ 1. Start ONE transaction that includes ALL stores we need to modify.
  const tx = db.transaction(
    ["historyLog", "redoLog", "nodeChunks", "hyperlights", "hypercites"],
    "readwrite"
  );
  const historyStore = tx.objectStore("historyLog");
  const redoStore = tx.objectStore("redoLog");
  const chunksStore = tx.objectStore("nodeChunks");
  const lightsStore = tx.objectStore("hyperlights");
  const citesStore = tx.objectStore("hypercites");

  // Use a cursor to get the very last item from the history log
  const cursor = await new Promise((resolve, reject) => {
    const request = historyStore.openCursor(null, "prev");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!cursor) {
    console.log("🌀 No history to undo.");
    tx.abort(); // Abort the transaction if there's nothing to do.
    return;
  }

  const logToUndo = cursor.value;
  console.log(`⏪ Undoing batch ID: ${logToUndo.id}`, logToUndo);

  const { updates, deletions } = logToUndo.payload;

  // ✅ 2. Perform the inverse logic from your correct transaction-based function.
  // --- Restore Deletions ---
  if (deletions.nodeChunks && deletions.nodeChunks.length > 0) {
    console.log(`Restoring ${deletions.nodeChunks.length} deleted nodes...`);
    deletions.nodeChunks.forEach((record) => chunksStore.put(record));
  }
  if (deletions.hyperlights && deletions.hyperlights.length > 0) {
    console.log(`Restoring ${deletions.hyperlights.length} deleted hyperlights...`);
    deletions.hyperlights.forEach((record) => lightsStore.put(record));
  }
  if (deletions.hypercites && deletions.hypercites.length > 0) {
    console.log(`Restoring ${deletions.hypercites.length} deleted hypercites...`);
    deletions.hypercites.forEach((record) => citesStore.put(record));
  }

  // --- Revert Updates & Creations ---
  if (updates.nodeChunks && updates.nodeChunks.length > 0) {
    const idsToDelete = updates.nodeChunks.map((record) => [
      record.book,
      record.startLine,
    ]);
    console.log(`Reverting ${idsToDelete.length} created/updated nodes...`);
    idsToDelete.forEach((key) => chunksStore.delete(key));
  }
  // (Add similar logic for hyperlight/hypercite updates if needed)

  // ✅ 3. MOVE the log entry to the redoLog instead of deleting it.
  console.log(`Moving batch ${logToUndo.id} to the redo log...`);
  redoStore.add(logToUndo); // Add it to the redo pile.
  cursor.delete(); // Delete it from the undo pile.

  // Wait for the single, unified transaction to complete.
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
    tx.onabort = (event) => reject(event.target.error);
  });

  console.log("✅ Undo complete. Reloading page to reflect changes.");
  if (currentLazyLoader) {
    await currentLazyLoader.refresh();
  } else {
    console.error("No active lazy loader found. Falling back to full page reload.");
    window.location.reload();
  }
}
// In historyManager.js

export async function redoLastBatch() {
  const db = await openDatabase();
  // ✅ 1. Start ONE transaction that includes ALL stores we need to modify.
  const tx = db.transaction(
    ["historyLog", "redoLog", "nodeChunks", "hyperlights", "hypercites"],
    "readwrite"
  );
  const historyStore = tx.objectStore("historyLog");
  const redoStore = tx.objectStore("redoLog");
  const chunksStore = tx.objectStore("nodeChunks");
  const lightsStore = tx.objectStore("hyperlights");
  const citesStore = tx.objectStore("hypercites");

  // Use a cursor to get the very last item from the redo log
  const cursor = await new Promise((resolve, reject) => {
    const request = redoStore.openCursor(null, "prev");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!cursor) {
    console.log("🌀 No history to redo.");
    tx.abort(); // Abort the transaction if there's nothing to do.
    return;
  }

  const logToRedo = cursor.value;
  console.log(`⏩ Redoing batch ID: ${logToRedo.id}`, logToRedo);

  const { updates, deletions } = logToRedo.payload;

  // ✅ 2. Re-apply the ORIGINAL actions directly within this transaction.
  // --- Re-apply Deletions ---
  if (deletions.nodeChunks && deletions.nodeChunks.length > 0) {
    const keysToDelete = deletions.nodeChunks.map((r) => [r.book, r.startLine]);
    console.log(`Re-deleting ${keysToDelete.length} nodes...`);
    keysToDelete.forEach((key) => chunksStore.delete(key));
  }
  if (deletions.hyperlights && deletions.hyperlights.length > 0) {
    const keysToDelete = deletions.hyperlights.map((r) => [r.book, r.hyperlight_id]);
    console.log(`Re-deleting ${keysToDelete.length} hyperlights...`);
    keysToDelete.forEach((key) => lightsStore.delete(key));
  }
  if (deletions.hypercites && deletions.hypercites.length > 0) {
    const keysToDelete = deletions.hypercites.map((r) => [r.book, r.hyperciteId]);
    console.log(`Re-deleting ${keysToDelete.length} hypercites...`);
    keysToDelete.forEach((key) => citesStore.delete(key));
  }

  // --- Re-apply Updates & Creations ---
  if (updates.nodeChunks && updates.nodeChunks.length > 0) {
    console.log(`Re-applying ${updates.nodeChunks.length} node updates...`);
    updates.nodeChunks.forEach((record) => chunksStore.put(record));
  }
  if (updates.hyperlights && updates.hyperlights.length > 0) {
    console.log(`Re-applying ${updates.hyperlights.length} hyperlight updates...`);
    updates.hyperlights.forEach((record) => lightsStore.put(record));
  }
  if (updates.hypercites && updates.hypercites.length > 0) {
    console.log(`Re-applying ${updates.hypercites.length} hypercite updates...`);
    updates.hypercites.forEach((record) => citesStore.put(record));
  }

  // ✅ 3. MOVE the log entry back to the historyLog.
  console.log(`Moving batch ${logToRedo.id} back to the history log...`);
  historyStore.add(logToRedo); // Add it back to the undo pile.
  cursor.delete(); // Delete it from the redo pile.

  // Wait for the single, unified transaction to complete.
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
    tx.onabort = (event) => reject(event.target.error);
  });

  console.log("✅ Redo complete. Reloading page to reflect changes.");
  if (currentLazyLoader) {
    await currentLazyLoader.refresh();
  } else {
    console.error("No active lazy loader found. Falling back to full page reload.");
    window.location.reload();
  }
}




