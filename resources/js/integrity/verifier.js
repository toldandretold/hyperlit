/**
 * Integrity Verifier
 *
 * Compares DOM textContent against IndexedDB stored content to detect
 * data loss where edits appear in the DOM but never persisted to IDB.
 *
 * Uses textContent (not innerHTML) because batch.js strips <mark>, <u>,
 * inline styles, and navigation classes before saving — full HTML will
 * always differ.
 */

import { openDatabase } from '../indexedDB/core/connection.js';

/**
 * Normalise text for comparison: trim and collapse all whitespace runs
 * to a single space. This makes the check resilient to minor formatting
 * differences between live DOM and stored HTML.
 */
function normaliseText(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse stored HTML content and extract its textContent using DOMParser.
 * This mirrors what the browser would render, minus any inline artefacts
 * that batch.js strips on save.
 */
function textFromStoredHTML(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

/**
 * Verify a set of nodes for a given bookId.
 *
 * Only checks nodes currently rendered in the DOM (lazy loading means
 * most nodes are not present). Runs inside requestIdleCallback to avoid
 * blocking user typing.
 *
 * @param {string} bookId   - The book (or sub-book) being verified
 * @param {Array}  nodeIds  - Array of numeric DOM id values to check
 * @returns {Promise<{ok: string[], mismatches: Array, missingFromIDB: string[], duplicateIds: Array}>}
 */
export function verifyNodesIntegrity(bookId, nodeIds) {
  return new Promise((resolve) => {
    const run = () => {
      _verifySync(bookId, nodeIds).then(resolve);
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 2000 });
    } else {
      setTimeout(run, 100);
    }
  });
}

/**
 * Internal synchronous (but async-IDB) verification.
 */
async function _verifySync(bookId, nodeIds) {
  const ok = [];
  const mismatches = [];
  const missingFromIDB = [];

  // Detect duplicate numeric IDs
  const idCounts = {};
  nodeIds.forEach(id => { idCounts[id] = (idCounts[id] || 0) + 1; });
  const duplicateIds = Object.entries(idCounts)
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }));

  let db;
  try {
    db = await openDatabase();
  } catch (e) {
    console.warn('[integrity] Could not open IDB for verification:', e);
    return { ok, mismatches, missingFromIDB };
  }

  const tx = db.transaction('nodes', 'readonly');
  const store = tx.objectStore('nodes');

  // Scope DOM lookups to the correct book container to avoid collisions
  // (nested sub-books all have nodes with id="1", id="2", etc.)
  const bookContainer = document.querySelector(`[data-book-id="${bookId}"]`)
    || document.getElementById(bookId);

  // For sub-books: if the container has been destroyed (closed), bail entirely.
  // Without this, getElementById("1") finds the PARENT book's node and
  // the false mismatch triggers self-healing that overwrites IDB with wrong content.
  const isSubBook = bookId.includes('/');
  if (isSubBook && !bookContainer) {
    console.warn(`[integrity] Sub-book container gone for ${bookId} — skipping verification`);
    return { ok, mismatches, missingFromIDB, duplicateIds };
  }

  const checks = nodeIds.map((nodeId) => {
    return new Promise((res) => {
      // Scoped lookup within the book container (avoids duplicate-ID collisions)
      let domEl = null;
      if (bookContainer) {
        domEl = bookContainer.querySelector(`[id="${nodeId}"]`);
      }
      // Fallback to global only for main content (no sub-book path separator)
      if (!domEl && !isSubBook) {
        domEl = document.getElementById(nodeId);
      }
      if (!domEl) {
        // Node not rendered (lazy-loaded away) — skip silently
        return res();
      }

      const domText = normaliseText(domEl.textContent);

      const numericId = typeof nodeId === 'number' ? nodeId : parseFloat(nodeId);
      if (isNaN(numericId)) return res();

      const key = [bookId, numericId];
      const req = store.get(key);

      req.onsuccess = () => {
        const record = req.result;
        const dataNodeId = domEl.getAttribute('data-node-id') || null;

        if (!record) {
          missingFromIDB.push({
            startLine: String(nodeId),
            nodeId: dataNodeId,
            tag: domEl.tagName,
            domText: domText.substring(0, 300),
          });
          return res();
        }

        const idbText = normaliseText(textFromStoredHTML(record.content));

        if (domText === idbText) {
          ok.push(String(nodeId));
        } else {
          mismatches.push({
            startLine: String(nodeId),
            nodeId: dataNodeId,
            domText: domText.substring(0, 300),
            idbText: idbText.substring(0, 300),
          });
        }
        res();
      };

      req.onerror = () => {
        console.warn(`[integrity] IDB read error for node ${nodeId}`);
        res();
      };
    });
  });

  await Promise.all(checks);
  return { ok, mismatches, missingFromIDB, duplicateIds };
}
