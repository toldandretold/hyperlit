// In historyManager.js

import { openDatabase } from "./cache-indexedDB.js";
import { currentLazyLoader } from "./initializePage.js";

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
    const request = historyStore.openCursor(null, "prev");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!cursor) {
    console.log("🌀 No history to undo.");
    tx.abort();
    return;
  }

  const logToUndo = cursor.value;
  console.log(`⏪ Undoing batch ID: ${logToUndo.id}`, logToUndo);

  // ✅ GET THE TARGET ID before we modify the database
  const targetId = getTargetIdFromPayload(logToUndo.payload);

  const { updates, deletions } = logToUndo.payload;

  // --- This is your existing, correct logic for reverting the database state ---
  if (deletions.nodeChunks && deletions.nodeChunks.length > 0) {
    deletions.nodeChunks.forEach((record) => chunksStore.put(record));
  }
  if (deletions.hyperlights && deletions.hyperlights.length > 0) {
    deletions.hyperlights.forEach((record) => lightsStore.put(record));
  }
  if (deletions.hypercites && deletions.hypercites.length > 0) {
    deletions.hypercites.forEach((record) => citesStore.put(record));
  }
  if (updates.nodeChunks && updates.nodeChunks.length > 0) {
    const idsToDelete = updates.nodeChunks.map((r) => [r.book, r.startLine]);
    idsToDelete.forEach((key) => chunksStore.delete(key));
  }
  // --- End of existing logic ---

  // Move the log entry to the redoLog
  redoStore.add(logToUndo);
  cursor.delete();

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });

  console.log("✅ Undo complete. Refreshing content...");
  if (currentLazyLoader) {
    // ✅ PASS THE TARGET ID to the refresh function
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
    const request = redoStore.openCursor(null, "prev");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!cursor) {
    console.log("🌀 No history to redo.");
    tx.abort();
    return;
  }

  const logToRedo = cursor.value;
  console.log(`⏩ Redoing batch ID: ${logToRedo.id}`, logToRedo);

  // ✅ GET THE TARGET ID before we modify the database
  const targetId = getTargetIdFromPayload(logToRedo.payload);

  const { updates, deletions } = logToRedo.payload;

  // --- This is your existing, correct logic for re-applying the actions ---
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
  // --- End of existing logic ---

  // Move the log entry back to the historyLog
  historyStore.add(logToRedo);
  cursor.delete();

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error);
  });

  console.log("✅ Redo complete. Refreshing content...");
  if (currentLazyLoader) {
    // ✅ PASS THE TARGET ID to the refresh function
    await currentLazyLoader.refresh(targetId);
  } else {
    window.location.reload();
  }
}