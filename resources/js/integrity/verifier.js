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
  return (str || '').replace(/[\u200B\u2060]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract textContent from an element while canonicalising <latex> and
 * <latex-block> elements. KaTeX renders math by injecting visible glyphs +
 * accessibility annotations *inside* the `<latex>` element, so live-DOM
 * textContent diverges from stored HTML (which keeps the element empty with
 * the LaTeX source in `data-math`). We replace either side with the same
 * stable string \u2014 the data-math attribute \u2014 so the comparison is consistent.
 */
function textContentCanonical(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll('latex, latex-block').forEach((el) => {
    el.textContent = el.getAttribute('data-math') || '';
  });
  return clone.textContent || '';
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
 * that batch.js strips on save. Uses textContentCanonical so <latex>
 * elements are compared by their data-math attribute, not rendered output.
 */
function textFromStoredHTML(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.body.firstElementChild;
  return textContentCanonical(el || doc.body);
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

      const domText = normaliseText(textContentCanonical(domEl));

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
 * Find pairs of block-level DOM elements that share the same data-node-id AND
 * have byte-identical innerHTML. These are unambiguous render duplicates —
 * the second one can be safely removed without losing data. Used by the
 * periodic-save self-heal path.
 *
 * @param {string} bookId
 * @returns {Array<{dataNodeId: string, keeper: HTMLElement, duplicates: HTMLElement[]}>}
 */
export function findVerbatimDuplicates(bookId) {
  const container = document.querySelector(`[data-book-id="${bookId}"]`)
    || document.getElementById(bookId);
  if (!container) return [];

  const byNodeId = new Map();
  container.querySelectorAll('[data-node-id]').forEach(el => {
    const id = el.getAttribute('data-node-id');
    if (!id) return;
    if (!byNodeId.has(id)) byNodeId.set(id, []);
    byNodeId.get(id).push(el);
  });

  const verbatim = [];
  for (const [dataNodeId, els] of byNodeId) {
    if (els.length < 2) continue;
    const keeper = els[0];
    const html = keeper.innerHTML;
    const duplicates = els.slice(1).filter(el => el.innerHTML === html);
    if (duplicates.length > 0) {
      verbatim.push({ dataNodeId, keeper, duplicates });
    }
  }
  return verbatim;
}

/**
 * Remove every verbatim DOM duplicate found by `findVerbatimDuplicates`.
 * Safe to run at any time — same data-node-id + identical innerHTML means no
 * data is lost. Returns the list of `id` attributes that were removed (used
 * by callers to attach to the self-heal report).
 *
 * @param {string} bookId
 * @returns {string[]}
 */
export function healVerbatimDuplicates(bookId) {
  const verbatim = findVerbatimDuplicates(bookId);
  if (verbatim.length === 0) return [];
  const removedIds = [];
  for (const { dataNodeId, duplicates } of verbatim) {
    for (const dup of duplicates) {
      removedIds.push(dup.id || dataNodeId);
      dup.remove();
    }
    console.log(`[integrity] Removed ${duplicates.length} verbatim DOM duplicate(s) for data-node-id=${dataNodeId}`);
  }
  return removedIds;
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

/**
 * Run the full integrity-sweep pipeline against a single book's DOM:
 *   1. heal verbatim DOM duplicates first (data-safe drop of identical
 *      data-node-id + identical innerHTML pairs)
 *   2. collect all numeric ids from the container
 *   3. verifyNodesIntegrity (DOM ↔ IDB text comparison)
 *   4. findOrphanedNodes (in-DOM elements that should have ids but don't)
 *   5. reportIntegrityFailure if any of (mismatches | missing | duplicates |
 *      orphans) come back non-empty
 *
 * Mirrors the block in `components/editButton.js` that runs when the main
 * book exits edit mode. Pull it out here so the sub-book equivalents
 * (hyperlit-container edit-toggle off, container close) get exactly the
 * same sweep — no asymmetry between main-book and sub-book paths.
 *
 * @param {string} bookId - The book id (main or sub-book like "book_X/Fn_Y")
 * @param {Element} containerEl - The DOM root to scan (`.main-content` for
 *   main book; `.sub-book-content[data-book-id="X"]` for a sub-book)
 * @param {string} trigger - Free-form label to thread through reportIntegrityFailure
 * @returns {Promise<{ok: boolean, mismatches, missingFromIDB, duplicateIds, orphans, healedIds}>}
 */
export async function runIntegritySweep(bookId, containerEl, trigger = 'unknown') {
  if (!bookId || !containerEl) {
    return { ok: true, mismatches: [], missingFromIDB: [], duplicateIds: [], orphans: [], healedIds: [] };
  }

  // 1. Heal verbatim duplicates BEFORE counting (so the verifier sees the cleaned DOM)
  const healedIds = healVerbatimDuplicates(bookId);

  // 2. Collect node ids
  const nodeIds = [];
  containerEl.querySelectorAll('[id]').forEach(el => {
    if (/^\d+(\.\d+)*$/.test(el.id)) nodeIds.push(el.id);
  });

  if (nodeIds.length === 0) {
    return { ok: true, mismatches: [], missingFromIDB: [], duplicateIds: [], orphans: [], healedIds };
  }

  // 3. Verify
  const result = await verifyNodesIntegrity(bookId, nodeIds);
  // 4. Orphans
  const orphans = findOrphanedNodes(bookId);

  const hasIssue = result.mismatches.length > 0
    || result.missingFromIDB.length > 0
    || result.duplicateIds.length > 0
    || orphans.length > 0;

  if (hasIssue) {
    try {
      const { reportIntegrityFailure } = await import('./reporter.js');
      reportIntegrityFailure({
        bookId,
        mismatches: result.mismatches,
        missingFromIDB: result.missingFromIDB,
        duplicateIds: result.duplicateIds,
        orphanedNodes: orphans,
        trigger,
        selfHealed: healedIds.length > 0,
        selfHealedNodeIds: healedIds,
      });
    } catch (e) {
      console.warn(`[integrity] runIntegritySweep failed to report for ${bookId} (${trigger}):`, e);
    }
  }

  return {
    ok: !hasIssue,
    mismatches: result.mismatches,
    missingFromIDB: result.missingFromIDB,
    duplicateIds: result.duplicateIds,
    orphans,
    healedIds,
  };
}
