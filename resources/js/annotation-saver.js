// annotationSaver.js
import { withPending } from './operationState.js';
import { openDatabase } from './cache-indexedDB.js';

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
    const tx = db.transaction('hyperlights','readwrite');
    const store = tx.objectStore('hyperlights');
    const idx   = store.index('hyperlight_id');
    const record = await new Promise((res, rej) => {
      const req = idx.get(highlightId);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
    if (!record) throw new Error('No highlight record');
    record.annotation = annotationHTML;
    await new Promise((res, rej) => {
      const upd = store.put(record);
      upd.onsuccess = () => res();
      upd.onerror   = () => rej(upd.error);
    });
    await new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  });

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
  let lastHTML = "";

  /* ------------------------------------------------------------ */
  /* track latest HTML on keyup                                   */
  /* ------------------------------------------------------------ */
  annotationEl.addEventListener("keyup", () => {
    lastHTML = annotationEl.innerHTML || "";
  });

  /* ------------------------------------------------------------ */
  /* save after 1 s of inactivity                                 */
  /* ------------------------------------------------------------ */
  annotationEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const html = lastHTML;

      withPending(async () => {
        /* 1 — update IndexedDB ----------------------------------- */
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
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });

        /* 2 — sync to PostgreSQL --------------------------------- */
        // ✅ FIXED: Use backend-managed auth system
        const payload = {
          book: rec.book,
          data: [
            {
              book: rec.book,
              hyperlight_id: rec.hyperlight_id,
              annotation: html
            }
          ]
          // ❌ REMOVED: anonymous_token - backend handles this via cookies
        };

        const response = await fetch("/api/db/hyperlights/upsert", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN":
              document.querySelector('meta[name="csrf-token"]')?.content
          },
          credentials: "include", // ✅ FIXED: Changed from "same-origin" to "include"
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error(
            `Failed to sync annotation (${response.status}): ${await response.text()}`
          );
        }
        console.log(`✅ Annotation synced to PostgreSQL for ${highlightId}`);
      }).catch(console.error);
    }, 1000);
  });
}