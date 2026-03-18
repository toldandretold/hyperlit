/**
 * Footnote Annotations Module
 * Handles saving footnote content edits (similar to highlight annotations)
 */

import { withPending } from "../utilities/operationState.js";
import { openDatabase, queueForSync } from "../indexedDB/index.js";
import { getCurrentContainer } from "../hyperlitContainer/stack.js";

/**
 * Get the current book ID from the DOM (more reliable than global variable)
 */
function getCurrentBookId() {
  const mainContent = document.querySelector('.main-content');
  return mainContent?.id || 'most-recent';
}

// Track active listeners for cleanup when container closes
const activeFootnoteListeners = [];

// Track pending debounce timers so they can be flushed on cleanup
// Map<footnoteId, { timer, save: () => Promise }>
const pendingFootnoteTimers = new Map();

/**
 * Save footnote content to IndexedDB
 * @param {string} footnoteId
 * @param {string} content
 */
export const saveFootnoteToIndexedDB = (footnoteId, content) =>
  withPending(async () => {
    const db = await openDatabase();
    const tx = db.transaction("footnotes", "readwrite");
    const store = tx.objectStore("footnotes");

    const bookId = getCurrentBookId();
    const key = [bookId, footnoteId];
    const record = await new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (!record) throw new Error(`No footnote record found for ${footnoteId}`);

    record.content = content;
    record.updated_at = new Date().toISOString();

    await new Promise((resolve, reject) => {
      const upd = store.put(record);
      upd.onsuccess = () => resolve();
      upd.onerror = () => reject(upd.error);
    });

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log(`Footnote ${footnoteId} saved to IndexedDB. Queuing for sync.`);
        // Use batched sync queue like highlights do
        queueForSync("footnotes", footnoteId, "update", record);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  });

/**
 * Attach input listener to footnote content with debouncing
 * Uses tracked listeners for proper cleanup when container closes
 * @param {string} footnoteId
 */
export function attachFootnoteListener(footnoteId) {
  const container = getCurrentContainer();
  if (!container || container.classList.contains("hidden")) return;

  const footnoteEl = container.querySelector(
    `.footnote-text[data-footnote-id="${footnoteId}"]`
  );
  if (!footnoteEl) {
    console.warn(`No .footnote-text found for footnote ID: ${footnoteId}`);
    return;
  }

  const handler = () => {
    const content = footnoteEl.innerHTML || "";

    // Clear any existing timer for this footnote
    const existing = pendingFootnoteTimers.get(footnoteId);
    if (existing) clearTimeout(existing.timer);

    const save = () => {
      pendingFootnoteTimers.delete(footnoteId);
      return saveFootnoteToIndexedDB(footnoteId, content)
        .then(() => console.log(`Footnote ${footnoteId} saved successfully`))
        .catch(console.error);
    };

    const timer = setTimeout(save, 1000);
    pendingFootnoteTimers.set(footnoteId, { timer, save });
  };

  footnoteEl.addEventListener("input", handler);
  activeFootnoteListeners.push({ element: footnoteEl, event: "input", handler });

  console.log(`Attached footnote listener for: ${footnoteId}`);
}

/**
 * Attach placeholder behavior for empty footnotes
 * Uses tracked listeners for proper cleanup when container closes
 * @param {string} footnoteId
 */
export function attachFootnotePlaceholderBehavior(footnoteId) {
  const footnoteEl = document.querySelector(
    `.footnote-text[data-footnote-id="${footnoteId}"]`
  );
  if (!footnoteEl) return;

  const isEffectivelyEmpty = (div) => !div.textContent.trim();

  const updatePlaceholder = () => {
    if (isEffectivelyEmpty(footnoteEl)) {
      footnoteEl.classList.add('empty-footnote');
    } else {
      footnoteEl.classList.remove('empty-footnote');
    }
  };

  updatePlaceholder();
  footnoteEl.addEventListener('input', updatePlaceholder);
  footnoteEl.addEventListener('focus', updatePlaceholder);
  footnoteEl.addEventListener('blur', updatePlaceholder);

  // Track for cleanup
  activeFootnoteListeners.push({ element: footnoteEl, event: 'input', handler: updatePlaceholder });
  activeFootnoteListeners.push({ element: footnoteEl, event: 'focus', handler: updatePlaceholder });
  activeFootnoteListeners.push({ element: footnoteEl, event: 'blur', handler: updatePlaceholder });
}

/**
 * Immediately fire all pending footnote annotation saves (clearing their timers).
 * Call before cleanup or container close to prevent data loss.
 */
export function flushPendingFootnoteSaves() {
  if (pendingFootnoteTimers.size === 0) return;
  console.log(`Flushing ${pendingFootnoteTimers.size} pending footnote save(s)`);
  for (const [footnoteId, { timer, save }] of pendingFootnoteTimers) {
    clearTimeout(timer);
    save(); // fire-and-forget — the save queues into IndexedDB + sync queue
  }
  pendingFootnoteTimers.clear();
}

/**
 * Clean up all footnote listeners
 * Called when the container closes to prevent listener accumulation
 */
export function cleanupFootnoteListeners() {
  // Flush any pending debounced saves before removing listeners
  flushPendingFootnoteSaves();

  for (const { element, event, handler } of activeFootnoteListeners) {
    try {
      element.removeEventListener(event, handler);
    } catch (e) {
      // Element may have been removed from DOM, ignore
    }
  }
  activeFootnoteListeners.length = 0;
}
