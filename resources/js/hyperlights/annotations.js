/**
 * Annotations module - Handles annotation saving and management
 */

import { withPending } from "../utilities/operationState.js";
import { openDatabase, queueForSync, updateAnnotationsTimestamp } from "../indexedDB/index.js";

/**
 * Extracts the current HTML content from within the annotation element.
 * Assumes .annotation is found inside the unified hyperlit container.
 * @param {HTMLElement} container
 * @returns {string} HTML string
 */
export function getAnnotationHTML(container) {
  const annotationEl = container.querySelector(".annotation");
  return annotationEl ? annotationEl.innerHTML : "";
}

/**
 * Save the annotation HTML to the hyperlights record in IndexedDB.
 * Uses the same schema as your existing addToHighlightsTable function.
 * @param {string} highlightId - Unique id for the highlight.
 * @param {string} annotationHTML - The annotation HTML to be saved.
 */
export const saveAnnotationToIndexedDB = (highlightId, annotationHTML) =>
  withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");
    const record = await new Promise((res, rej) => {
      const req = idx.get(highlightId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (!record) throw new Error("No highlight record");
    record.annotation = annotationHTML;
    await new Promise((res, rej) => {
      const upd = store.put(record);
      upd.onsuccess = () => res();
      upd.onerror = () => rej(upd.error);
    });
    await new Promise((res, rej) => {
      tx.oncomplete = () => {
        console.log(
          `Annotation for ${highlightId} saved via helper. Queuing for sync.`
        );
        // MODIFIED: Pass the full 'record' object to the queue.
        queueForSync("hyperlights", highlightId, "update", record);
        res();
      };
      tx.onerror = () => rej(tx.error);
    });
  });

/**
 * Attach annotation input listener with debouncing
 * @param {string} highlightId - The highlight ID
 */
export function attachAnnotationListener(highlightId) {
  const container = document.getElementById("hyperlit-container");
  if (!container || container.classList.contains("hidden")) return;

  const annotationEl = container.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  );
  if (!annotationEl) {
    console.warn(`No .annotation found for highlight ID: ${highlightId}`);
    return;
  }

  let debounceTimer = null;

  annotationEl.addEventListener("input", () => {
    const html = annotationEl.innerHTML || "";

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      withPending(async () => {
        const db = await openDatabase();
        const tx = db.transaction("hyperlights", "readwrite");
        const store = tx.objectStore("hyperlights");
        const idx = store.index("hyperlight_id");
        const rec = await new Promise((res, rej) => {
          const r = idx.get(highlightId);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (!rec) throw new Error("No highlight record");

        rec.annotation = html;
        await new Promise((res, rej) => {
          const u = store.put(rec);
          u.onsuccess = () => res();
          u.onerror = () => rej(u.error);
        });

        await new Promise((res, rej) => {
          tx.oncomplete = () => {
            console.log(
              `✅ Annotation for ${highlightId} saved to IndexedDB. Queuing for sync.`
            );
            // MODIFIED: Pass the full 'rec' object to the queue.
            queueForSync("hyperlights", highlightId, "update", rec);
            updateAnnotationsTimestamp(rec.book);
            res();
          };
          tx.onerror = () => rej(tx.error);
        });
      }).catch(console.error);
    }, 1000);
  });
}

/**
 * Save annotation directly (used by noteListener)
 * @param {string} highlightId - The highlight ID
 * @param {string} annotationHTML - The annotation HTML
 */
export const saveHighlightAnnotation = (highlightId, annotationHTML) =>
  withPending(async () => {
    if (!highlightId) return;

    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    const index = store.index("hyperlight_id");

    const highlightData = await new Promise((res, rej) => {
      const req = index.get(highlightId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

    if (!highlightData) return;

    highlightData.annotation = annotationHTML;

    await new Promise((res, rej) => {
      const updateRequest = store.put(highlightData);
      updateRequest.onsuccess = () => res();
      updateRequest.onerror = () => rej(updateRequest.error);
    });

    await new Promise((res, rej) => {
      tx.oncomplete = () => {
        console.log(`Successfully saved annotation for highlight ${highlightId}`);
        queueForSync("hyperlights", highlightId, "update", highlightData);
        updateAnnotationsTimestamp(highlightData.book);
        res();
      };
      tx.onerror = () => rej(tx.error);
    });
  });
