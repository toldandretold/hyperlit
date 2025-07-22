// annotationSaver.js

import { withPending } from "./operationState.js";
// 👈 1. IMPORT queueForSync
import { openDatabase, queueForSync } from "./cache-indexedDB.js";

// Debounce timer variable for the highlight container.
let annotationDebounceTimer = null;

/**
 * Extracts the current HTML content from within the annotation element.
 * Assumes .annotation is found inside the highlight container.
 * @param {HTMLElement} container
 * @returns {string} HTML string
 */
function getAnnotationHTML(container) {
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
        // 👈 2. ADD QUEUE CALL TO THE HELPER
        console.log(
          `Annotation for ${highlightId} saved via helper. Queuing for sync.`
        );
        queueForSync("hyperlights", highlightId);
        res();
      };
      tx.onerror = () => rej(tx.error);
    });
  });

// IN annotationSaver.js, REPLACE the attachAnnotationListener function with this:

export function attachAnnotationListener(highlightId) {
  const container = document.getElementById("highlight-container");
  if (!container || container.classList.contains("hidden")) return;

  const annotationEl = container.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  );
  if (!annotationEl) {
    console.warn(`No .annotation found for highlight ID: ${highlightId}`);
    return;
  }

  let debounceTimer = null;
  // ❌ The 'lastHTML' variable is no longer needed.

  /* ❌ The 'keyup' event listener is removed entirely. */

  /* ------------------------------------------------------------ */
  /* save after 1 s of inactivity (now handles all input types)   */
  /* ------------------------------------------------------------ */
  annotationEl.addEventListener("input", () => {
    // 👈 THE FIX: Get the current HTML right away.
    const html = annotationEl.innerHTML || "";

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // The rest of your logic remains the same, but it now uses the
      // correct 'html' variable captured when the input event fired.
      withPending(async () => {
        /* 1 — update IndexedDB */
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
            queueForSync("hyperlights", highlightId);
            res();
          };
          tx.onerror = () => rej(tx.error);
        });
      }).catch(console.error);
    }, 1000);
  });
}