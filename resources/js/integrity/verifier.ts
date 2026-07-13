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

import { openDatabase } from '../indexedDB/core/connection';
import { INLINE_SKIP_TAGS, BLOCK_ELEMENT_TAGS } from '../utilities/blockElements';
import { asLineId, isDuplicateId, getNextDecimalForBase, generateDataNodeId, generateUniqueId, type LineId, type BookId } from '../utilities/idHelpers';

/** First-difference descriptor between DOM text and stored IDB text. */
export interface TextDiff {
  diffIndex: number;
  snippetA: string;
  snippetB: string;
}

/**
 * Raw (pre-normalisation) character codes on each side of the first diff, for
 * BOTH the live DOM text and the stored IDB text. normaliseText() strips
 * zero-width chars (​/⁠) and collapses whitespace before comparison,
 * so the normalised snippets can't reveal what is actually stored at the seam
 * (a word joiner? a real space? nothing?). These codes can — they are the only
 * way to tell those apart post-hoc.
 */
export interface DiffCharCodes {
  /** index into the RAW (un-normalised) DOM text that aligns with the diff region */
  domCodes: number[];
  idbCodes: number[];
  domSlice: string;
  idbSlice: string;
}

/** A node whose DOM text disagrees with its stored IDB content. */
export interface NodeMismatch {
  startLine: LineId;
  nodeId: string | null;
  domText: string;
  idbText: string;
  diff?: TextDiff | null;
  /** outerHTML of the live DOM node (truncated) — Defect-2 diagnostics */
  rawDomHtml?: string;
  /** the stored NodeRecord.content HTML (truncated) — Defect-2 diagnostics */
  rawIdbHtml?: string;
  /** char codes around the diff seam in the raw DOM/IDB text — Defect-2 diagnostics */
  codesAroundDiff?: DiffCharCodes | null;
}

/** A node present in the DOM but absent from IDB. */
export interface MissingNode {
  startLine: LineId;
  nodeId: string | null;
  tag: string;
  domText: string;
}

/** A numeric DOM id that appears more than once. */
export interface DuplicateId {
  id: LineId;
  count: number;
}

/** Result of verifyNodesIntegrity — the per-node DOM↔IDB reconciliation. */
export interface IntegrityResult {
  ok: LineId[];
  mismatches: NodeMismatch[];
  missingFromIDB: MissingNode[];
  duplicateIds: DuplicateId[];
}

/**
 * Normalise text for comparison: trim and collapse all whitespace runs
 * to a single space. This makes the check resilient to minor formatting
 * differences between live DOM and stored HTML.
 */
function normaliseText(str: any) {
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
function textContentCanonical(node: any) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll('latex, latex-block').forEach((el: any) => {
    el.textContent = el.getAttribute('data-math') || '';
  });
  return clone.textContent || '';
}

/**
 * Find the first character index where two strings diverge.
 * Returns an object with the diff index and ~50-char snippets around it.
 */
function findFirstDiff(a: any, b: any) {
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

/** Char codes for `2*radius+1` chars centred on `index` (clamped). */
function charCodesAt(str: string, index: number, radius = 10) {
  const start = Math.max(0, index - radius);
  const end = Math.min(str.length, index + radius + 1);
  const slice = str.slice(start, end);
  const codes: number[] = [];
  for (let i = 0; i < slice.length; i++) codes.push(slice.charCodeAt(i));
  return { slice, codes };
}

/**
 * Build the raw (pre-normalisation) char-code diagnostic for a mismatch.
 * Locates the first divergence in the RAW DOM/IDB text (not the normalised
 * strings the comparison used) and dumps the code points on each side — the
 * only way to see a zero-width joiner / collapsed space that normaliseText hid.
 */
function buildCodesAroundDiff(rawDom: string, rawIdb: string): DiffCharCodes {
  const len = Math.min(rawDom.length, rawIdb.length);
  let i = 0;
  while (i < len && rawDom[i] === rawIdb[i]) i++;
  const dom = charCodesAt(rawDom, i);
  const idb = charCodesAt(rawIdb, i);
  return { domCodes: dom.codes, idbCodes: idb.codes, domSlice: dom.slice, idbSlice: idb.slice };
}

/**
 * Parse stored HTML content and extract its textContent using DOMParser.
 * This mirrors what the browser would render, minus any inline artefacts
 * that batch.js strips on save. Uses textContentCanonical so <latex>
 * elements are compared by their data-math attribute, not rendered output.
 */
function textFromStoredHTML(html: any) {
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
export function verifyNodesIntegrity(bookId: BookId, nodeIds: LineId[]) : Promise<IntegrityResult> {
  return new Promise<IntegrityResult>((resolve) => {
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
async function _verifySync(bookId: BookId, nodeIds: LineId[]): Promise<IntegrityResult> {
  const ok: LineId[] = [];
  const mismatches: NodeMismatch[] = [];
  const missingFromIDB: MissingNode[] = [];

  // Detect duplicate numeric IDs
  const idCounts: Record<string, number> = {};
  nodeIds.forEach((id) => { idCounts[id] = (idCounts[id] || 0) + 1; });
  const duplicateIds: DuplicateId[] = Object.entries(idCounts)
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id: asLineId(id), count }));

  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (e) {
    console.warn('[integrity] Could not open IDB for verification:', e);
    return { ok, mismatches, missingFromIDB, duplicateIds };
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

  const checks = nodeIds.map((nodeId: any) => {
    return new Promise<void>((res) => {
      // Scoped lookup within the book container (avoids duplicate-ID collisions)
      let domEl: any = null;
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

      const rawDomText = textContentCanonical(domEl);
      const domText = normaliseText(rawDomText);

      const numericId = typeof nodeId === 'number' ? nodeId : parseFloat(nodeId);
      if (isNaN(numericId)) return res();

      const key = [bookId, numericId];
      const req = store.get(key);

      req.onsuccess = () => {
        const record = req.result;
        const dataNodeId = domEl.getAttribute('data-node-id') || null;

        if (!record) {
          missingFromIDB.push({
            startLine: asLineId(String(nodeId)),
            nodeId: dataNodeId,
            tag: domEl.tagName,
            domText,
          });
          return res();
        }

        const rawIdbText = textFromStoredHTML(record.content);
        const idbText = normaliseText(rawIdbText);

        if (domText === idbText) {
          ok.push(asLineId(String(nodeId)));
        } else {
          const codesAroundDiff = buildCodesAroundDiff(rawDomText, rawIdbText);
          // Surface the raw seam in the console so it's captured in the report's
          // "Recent Console Logs" even without server-side payload access.
          console.warn(
            `[integrity] Node ${nodeId} raw diff seam — DOM codes ${JSON.stringify(codesAroundDiff.domCodes)} | IDB codes ${JSON.stringify(codesAroundDiff.idbCodes)}`,
          );
          mismatches.push({
            startLine: asLineId(String(nodeId)),
            nodeId: dataNodeId,
            domText,
            idbText,
            diff: findFirstDiff(domText, idbText),
            rawDomHtml: (domEl.outerHTML || '').slice(0, 800),
            rawIdbHtml: (record.content || '').slice(0, 800),
            codesAroundDiff,
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
export function findVerbatimDuplicates(bookId: any) : any {
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

  const verbatim: any[] = [];
  for (const [dataNodeId, els] of byNodeId) {
    if (els.length < 2) continue;
    const keeper = els[0];
    const html = keeper.innerHTML;
    const duplicates = els.slice(1).filter((el: any) => el.innerHTML === html);
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
export function healVerbatimDuplicates(bookId: any) : any {
  const verbatim = findVerbatimDuplicates(bookId);
  if (verbatim.length === 0) return [];
  const removedIds: any[] = [];
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
 * Heal numeric-id duplicates: two+ DOM elements sharing the same positional id
 * (e.g. a phantom `id="1"` minted when a freshly-pasted node had no numeric
 * neighbours). Unlike `healVerbatimDuplicates`, the duplicates here may have
 * DIFFERENT data-node-ids and content, so we cannot blindly delete — that would
 * risk dropping unsaved content. The strategy is data-safe:
 *
 *   - Keeper = the element whose `data-node-id` matches the IDB record stored at
 *     that startLine (the canonical node); else the first occurrence.
 *   - A non-keeper is REMOVED only when it is provably redundant: empty, OR its
 *     content equals the keeper's, OR its `data-node-id` is already persisted in
 *     IDB (so the content lives elsewhere and the dup is a stray render).
 *   - Otherwise the non-keeper carries distinct, unsaved content → reassign it a
 *     fresh non-colliding id and queue a save so it survives the next reload.
 *
 * Returns a list of human-readable heal actions (for the report's selfHealed log).
 *
 * @param {string} bookId
 * @returns {Promise<string[]>}
 */
export async function healDuplicateIds(bookId: any): Promise<string[]> {
  const container = document.querySelector(`[data-book-id="${bookId}"]`)
    || document.getElementById(bookId);
  if (!container) return [];

  // Group block elements by numeric id; only collisions matter.
  const byId = new Map<string, HTMLElement[]>();
  container.querySelectorAll('[id]').forEach((el: any) => {
    if (!/^\d+(\.\d+)*$/.test(el.id)) return;
    const arr = byId.get(el.id);
    if (arr) arr.push(el); else byId.set(el.id, [el]);
  });
  const dupGroups = Array.from(byId.entries()).filter(([, els]) => els.length > 1);
  if (dupGroups.length === 0) return [];

  // Load the book's records once: startLine → canonical node_id, plus the full
  // set of persisted node_ids (to spot already-saved render-duplicates).
  let records: any[] = [];
  try {
    const { getNodesFromIndexedDB } = await import('../indexedDB/nodes/read');
    records = await getNodesFromIndexedDB(bookId);
  } catch (e) {
    console.warn('[integrity] healDuplicateIds could not read IDB — skipping', e);
    return [];
  }
  const nodeIdAtStartLine = new Map<number, string | null>();
  const persistedNodeIds = new Set<string>();
  for (const r of records) {
    nodeIdAtStartLine.set(parseFloat(r.startLine), r.node_id ?? null);
    if (r.node_id) persistedNodeIds.add(r.node_id);
  }

  const healed: string[] = [];

  for (const [id, els] of dupGroups) {
    const canonicalNodeId = nodeIdAtStartLine.get(parseFloat(id)) ?? null;

    // Keeper = element whose data-node-id matches the stored record; else first.
    let keeper = els[0]!;
    if (canonicalNodeId) {
      const match = els.find((el) => el.getAttribute('data-node-id') === canonicalNodeId);
      if (match) keeper = match;
    }

    for (const el of els) {
      if (el === keeper) continue;
      const dataNodeId = el.getAttribute('data-node-id');
      const isEmpty = !el.textContent?.trim() && !el.querySelector('img, sup');
      const alreadyPersisted = dataNodeId ? persistedNodeIds.has(dataNodeId) : false;
      const sameAsKeeper = el.innerHTML === keeper.innerHTML;

      if (isEmpty || alreadyPersisted || sameAsKeeper) {
        el.remove();
        healed.push(`${id}×removed`);
        continue;
      }

      // Distinct, unsaved content — rescue under a fresh non-colliding id.
      const baseMatch = id.match(/^(\d+)/);
      let newId = baseMatch ? getNextDecimalForBase(baseMatch[1]!) : generateUniqueId();
      el.id = newId;
      // getNextDecimalForBase now scans document-wide and cannot return an in-use
      // id, but keep this as a last-resort backstop before committing.
      if (isDuplicateId(newId)) {
        newId = generateUniqueId();
        el.id = newId;
      }
      if (!el.getAttribute('data-node-id')) {
        el.setAttribute('data-node-id', generateDataNodeId(bookId));
      }
      try {
        const { queueNodeForSave } = await import('../divEditor/index');
        queueNodeForSave(newId, 'add', bookId);
      } catch (e) {
        console.warn('[integrity] healDuplicateIds could not queue save for', newId, e);
      }
      healed.push(`${id}→${newId}`);
    }
  }

  if (healed.length) {
    console.log(`[integrity] Healed ${healed.length} duplicate-id node(s):`, healed);
  }
  return healed;
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
export function findOrphanedNodes(bookId: any) : any {

  const container = document.querySelector(`[data-book-id="${bookId}"]`)
    || document.getElementById(bookId);
  if (!container) return [];

  const orphans: any[] = [];

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
export async function runIntegritySweep(bookId: any, containerEl: any, trigger = 'unknown') : Promise<any> {
  if (!bookId || !containerEl) {
    return { ok: true, mismatches: [], missingFromIDB: [], duplicateIds: [], orphans: [], healedIds: [] };
  }

  // 1. Heal duplicates BEFORE counting (so the verifier sees the cleaned DOM):
  //    verbatim dups (identical data-node-id + innerHTML) first, then numeric-id
  //    collisions (e.g. a phantom id="1" from a paste race) — data-safe.
  const healedIds = healVerbatimDuplicates(bookId);
  const healedDupIds = await healDuplicateIds(bookId);
  if (healedDupIds.length > 0) healedIds.push(...healedDupIds);

  // 2. Collect node ids
  const nodeIds: any[] = [];
  containerEl.querySelectorAll('[id]').forEach((el: any) => {
    if (/^\d+(\.\d+)*$/.test(el.id)) nodeIds.push(el.id);
  });

  if (nodeIds.length === 0) {
    return { ok: true, mismatches: [], missingFromIDB: [], duplicateIds: [], orphans: [], healedIds };
  }

  // 3. Verify
  const result: any = await verifyNodesIntegrity(bookId, nodeIds);
  // 4. Orphans
  const orphans = findOrphanedNodes(bookId);

  const hasIssue = result.mismatches.length > 0
    || result.missingFromIDB.length > 0
    || result.duplicateIds.length > 0
    || orphans.length > 0;

  if (hasIssue) {
    try {
      const { reportIntegrityFailure } = await import('./reporter');
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
