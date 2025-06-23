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

  // Find the specific annotation element for this highlight ID
  const annotationEl = container.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  );
  if (!annotationEl) {
    console.warn(`No .annotation found for highlight ID: ${highlightId}`);
    return;
  }

  let debounceTimer = null;
  let lastHTML = "";

  // Update lastHTML on keyup - scoped to this specific annotation element
  annotationEl.addEventListener('keyup', () => {
    lastHTML = annotationEl.innerHTML || '';
  });

  // Input listener - scoped to this specific annotation element
  annotationEl.addEventListener('input', () => {
    // Schedule save
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const html = lastHTML;
      // Wrap the entire save in withPending
      withPending(async () => {
        const db = await openDatabase();
        const tx = db.transaction('hyperlights','readwrite');
        const store = tx.objectStore('hyperlights');
        const idx   = store.index('hyperlight_id');
        const req   = idx.get(highlightId);

        const record = await new Promise((res, rej) => {
          req.onsuccess = () => res(req.result);
          req.onerror   = () => rej(req.error);
        });
        if (!record) throw new Error('No highlight record');

        record.annotation = html;
        await new Promise((res, rej) => {
          const upd = store.put(record);
          upd.onsuccess = () => res();
          upd.onerror   = () => rej(upd.error);
        });

        // Wait for tx complete
        await new Promise((res, rej) => {
          tx.oncomplete = () => res();
          tx.onerror    = () => rej(tx.error);
        });

        // Sync annotation to PostgreSQL
        try {
          const response = await fetch('/api/db/hyperlights/upsert', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
            },
            body: JSON.stringify({
              data: [{
                book: record.book,
                hyperlight_id: record.hyperlight_id,
                annotation: html
              }]
            })
          });

          if (!response.ok) {
            throw new Error(`Failed to sync annotation: ${response.statusText}`);
          }

          console.log(`Annotation synced to PostgreSQL for ${highlightId}`);
        } catch (error) {
          console.error(`Error syncing annotation to PostgreSQL for ${highlightId}:`, error);
        }
      }).catch(console.error);
    }, 1000);
  });
}