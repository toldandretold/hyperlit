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
import { INLINE_SKIP_TAGS, BLOCK_ELEMENT_TAGS } from '../utilities/blockElements.js';

/**
 * Normalise text for comparison: trim and collapse all whitespace runs
 * to a single space. This makes the check resilient to minor formatting
 * differences between live DOM and stored HTML.
 */
function normaliseText(str) {
  return (str || '').replace(/\u2060/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the first character index where two strings diverge.
 * Returns an object with the diff index and ~50-char snippets around it.
 */
function findFirstDiff(a, b) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  // If all shared chars match, the diff is at the length boundary
  if (i === len && a.length === b.length) return null; // identical
  const start = Math.max(0, i - 25);
  const end = i + 25;
  return {
    diffIndex: i,
    snippetA: a.slice(start, end),
    snippetB: b.slice(start, end),
    aLen: a.length,
    bLen: b.length,
  };
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

      // Skip inline formatting elements (browser artifacts from copy-paste)
      if (INLINE_SKIP_TAGS.has(domEl.tagName)) {
        return res(); // Not a real node — skip silently
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
            domText,
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
            domText,
            idbText,
            diff: findFirstDiff(domText, idbText),
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

/**
 * Scan for block-level elements without numeric IDs ("orphaned nodes").
 *
 * These are elements that were inserted into the DOM (e.g. via paste) but
 * never assigned an ID, so they are invisible to the save pipeline and
 * will vanish on reload.
 *
 * @param {string} bookId - The book (or sub-book) to scan
 * @returns {Array<{tag: string, textSnippet: string, element: HTMLElement}>}
 */
export function findOrphanedNodes(bookId) {

  const container = document.querySelector(`[data-book-id="${bookId}"]`)
    || document.getElementById(bookId);
  if (!container) return [];

  const orphans = [];

  // For chunked books, iterate direct children of each chunk wrapper
  const chunks = container.querySelectorAll('[data-chunk-id]');
  const parents = chunks.length > 0 ? Array.from(chunks) : [container];

  for (const parent of parents) {
    for (const child of parent.children) {
      // Skip chunk wrappers themselves
      if (child.hasAttribute('data-chunk-id')) continue;
      // Skip lazy-load sentinels
      if (child.hasAttribute('data-sentinel')) continue;

      if (!BLOCK_ELEMENT_TAGS.has(child.tagName)) continue;

      // Has a valid numeric ID → not orphaned
      if (child.id && /^\d+(\.\d+)*$/.test(child.id)) continue;

      orphans.push({
        tag: child.tagName,
        textSnippet: (child.textContent || '').substring(0, 200),
        element: child,
      });
    }
  }

  return orphans;
}
