/**
 * IDB / footnote-map inspection helpers for Playwright tests.
 *
 * The footnote system has three independent representations of ordering:
 *   1. `node.content` HTML stored in IndexedDB — has literal <sup fn-count-id="N">N</sup>
 *   2. `node.footnotes` array in IndexedDB — [{id, marker}]
 *   3. In-memory `footnoteMap` in FootnoteNumberingService — built by walking
 *      all nodes in startLine order and assigning 1,2,3,… to each new id
 *
 * For the system to look right to the user (and to the integrity checker),
 * all three must agree per footnote ID. These helpers let tests dump all
 * three and report exactly where they diverge.
 *
 * Companion to `helpers/integrityCapture.js` — that one catches mismatches
 * *after* they happen; this one lets us see the underlying state directly.
 */

/**
 * Init script: enable the in-app `window.__fnDiag` hook so DOM-sup mutations
 * by the renderer are recorded. Install via `page.addInitScript(enableFnDiagScript)`
 * before navigating.
 */
export const enableFnDiagScript = () => {
  // FootnoteNumberingService creates `window.__fnDiag = { enabled: false, ... }`
  // on its first import. We flip `enabled: true` here so a test run records
  // mutations. The hook itself is gated, so production is unaffected.
  Object.defineProperty(window, '__fnDiagEnabledByTest', { value: true, writable: false });
  // The service may not be loaded yet; set a getter that the service's
  // own assignment will override, but preserve enabled=true.
  let current = { enabled: true, rebuildCount: 0, domMutations: [] };
  Object.defineProperty(window, '__fnDiag', {
    configurable: true,
    get() { return current; },
    set(v) {
      // Service assigns a default object; merge enabled=true into it.
      current = { ...v, enabled: true };
    },
  });
};

/**
 * Dump every IDB node for the given bookId. Returns the raw records
 * (book, startLine, chunk_id, node_id, content, footnotes, ...).
 *
 * Reads via the same MarkdownDB the app uses. Uses a fresh transaction so
 * no in-flight write can hide.
 */
export async function dumpBookNodes(page, bookId) {
  return page.evaluate(async (bookId) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('MarkdownDB');
      req.onerror = () => reject(new Error('open MarkdownDB failed'));
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('nodes', 'readonly');
        const store = tx.objectStore('nodes');
        const out = [];
        const cursorReq = store.index('book').openCursor(IDBKeyRange.only(bookId));
        cursorReq.onsuccess = (evt) => {
          const cursor = evt.target.result;
          if (!cursor) {
            out.sort((a, b) => Number(a.startLine) - Number(b.startLine));
            db.close();
            return resolve(out);
          }
          const n = cursor.value;
          out.push({
            book: n.book,
            startLine: n.startLine,
            chunk_id: n.chunk_id ?? null,
            node_id: n.node_id ?? null,
            content: n.content || '',
            footnotes: Array.isArray(n.footnotes) ? n.footnotes : [],
          });
          cursor.continue();
        };
        cursorReq.onerror = () => reject(new Error('cursor failed'));
      };
    });
  }, bookId);
}

/**
 * Parse a node's content HTML and return the sups it contains.
 * Pure function — runs in Node, not in the page.
 *
 * Each entry: { footnoteId, fnCountId, supText, anchorText, hasAnchor }
 * Order is document order within the node.
 */
export function extractSupsFromContent(html) {
  if (!html) return [];
  const supRe = /<sup\b[^>]*\bfn-count-id\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/sup>/gi;
  // Match `id="..."` only when preceded by whitespace, `<` (start of tag), or
  // start-of-string. `\b` is the wrong anchor here because the `-` in
  // `fn-count-id` and `fn-section-id` is a word boundary, so `\bid\b` would
  // happily match those suffixes. Require space/tag-start instead.
  const supIdRe = /(?:^|[\s<])id\s*=\s*"([^"]*)"/i;
  const hrefRe = /(?:^|[\s<])href\s*=\s*"#([^"]*)"/i;
  const anchorRe = /<a\b[^>]*>([\s\S]*?)<\/a>/i;
  const tagStripRe = /<[^>]+>/g;
  const out = [];
  let m;
  while ((m = supRe.exec(html)) !== null) {
    const supTag = m[0];
    const inner = m[1] != null ? m[1] : '';
    const fnCountId = inner;
    const body = m[2] || '';
    // Capture just the <sup ...> opening tag for id extraction (excludes body
    // so an inner anchor's id can't be confused for the sup's id).
    const openTag = supTag.slice(0, supTag.indexOf('>') + 1);

    // Identify footnoteId: prefer anchor href, fall back to sup's own id
    const anchorMatch = body.match(anchorRe);
    let footnoteId = null;
    if (anchorMatch) {
      const aTag = body.slice(anchorMatch.index, anchorMatch.index + anchorMatch[0].indexOf('>') + 1);
      const hrefMatch = aTag.match(hrefRe);
      if (hrefMatch) footnoteId = hrefMatch[1];
    }
    if (!footnoteId) {
      const supIdMatch = openTag.match(supIdRe);
      if (supIdMatch) {
        let raw = supIdMatch[1];
        if (raw.endsWith('ref')) raw = raw.slice(0, -3);
        footnoteId = raw || null;
      }
    }
    const anchorText = anchorMatch ? anchorMatch[1].replace(tagStripRe, '').trim() : null;
    const supTextRaw = body.replace(tagStripRe, '').trim();
    out.push({
      footnoteId,
      fnCountId,
      supText: supTextRaw,
      anchorText,
      hasAnchor: Boolean(anchorMatch),
    });
  }
  return out;
}

/**
 * Read the in-memory footnote map snapshot. Returns
 *   { bookId, mapEntries: [[footnoteId, displayNumber], ...], rebuildCount, domMutations }
 * or null if the diag hook isn't installed.
 */
export async function getFnDiagSnapshot(page) {
  return page.evaluate(() => {
    if (!window.__fnDiag) return null;
    const snap = typeof window.__fnDiag.snapshot === 'function'
      ? window.__fnDiag.snapshot()
      : { bookId: null, mapEntries: [], rebuildCount: 0 };
    return {
      bookId: snap.bookId,
      mapEntries: snap.mapEntries,
      rebuildCount: snap.rebuildCount,
      domMutations: Array.isArray(window.__fnDiag.domMutations)
        ? window.__fnDiag.domMutations.slice()
        : [],
      enabled: !!window.__fnDiag.enabled,
    };
  });
}

/**
 * Cross-check all three representations for a book.
 *
 * Pure function. Pass the outputs of dumpBookNodes + getFnDiagSnapshot.
 * Returns a list of violations — empty array means everything agrees.
 *
 * Violation shapes:
 *   { kind: 'array_missing_id', startLine, footnoteId }
 *     `node.content` had a sup whose id isn't in `node.footnotes`
 *   { kind: 'content_missing_id', startLine, footnoteId }
 *     `node.footnotes` has an id that doesn't appear as a sup in the content
 *   { kind: 'marker_mismatch', startLine, footnoteId, htmlFnCountId, arrayMarker }
 *     `node.footnotes[i].marker` disagrees with the sup's `fn-count-id`
 *   { kind: 'map_disagrees_with_html', startLine, footnoteId, htmlFnCountId, mapDisplay }
 *     The map's displayNumber doesn't match what's literally in the stored HTML.
 *     This is the smoking gun for the user's bug — when this fires, the
 *     renderer's overwrite will create the integrity-checker mismatch.
 *   { kind: 'map_missing_id', startLine, footnoteId }
 *     A footnote ID appears in stored HTML but the map has no entry for it.
 *   { kind: 'duplicate_id_in_array', startLine, footnoteId, count }
 *     Same footnote id appears more than once in node.footnotes
 *   { kind: 'duplicate_id_in_content', startLine, footnoteId, count }
 *     Same footnote id appears more than once as a sup in node.content
 */
export function analyseFootnoteInvariants({ idbNodes, mapEntries }) {
  const violations = [];
  const mapByFootnoteId = new Map(mapEntries || []);

  for (const node of idbNodes) {
    const sups = extractSupsFromContent(node.content);

    // Index sups by footnoteId for fast lookup
    const supsById = new Map();
    for (const s of sups) {
      if (!s.footnoteId) continue;
      if (!supsById.has(s.footnoteId)) supsById.set(s.footnoteId, []);
      supsById.get(s.footnoteId).push(s);
    }

    // Index node.footnotes entries by id
    const arrayById = new Map();
    for (const f of node.footnotes) {
      const id = typeof f === 'string' ? f : f?.id;
      if (!id) continue;
      if (!arrayById.has(id)) arrayById.set(id, []);
      arrayById.get(id).push(f);
    }

    // Duplicates in content sups
    for (const [fid, arr] of supsById) {
      if (arr.length > 1) {
        violations.push({
          kind: 'duplicate_id_in_content',
          startLine: node.startLine,
          footnoteId: fid,
          count: arr.length,
        });
      }
    }
    // Duplicates in node.footnotes
    for (const [fid, arr] of arrayById) {
      if (arr.length > 1) {
        violations.push({
          kind: 'duplicate_id_in_array',
          startLine: node.startLine,
          footnoteId: fid,
          count: arr.length,
        });
      }
    }

    // Content sup → array round-trip
    for (const [fid, arr] of supsById) {
      const htmlFnCountId = arr[0].fnCountId;
      const arrayEntry = arrayById.get(fid)?.[0];
      if (!arrayEntry) {
        violations.push({
          kind: 'array_missing_id',
          startLine: node.startLine,
          footnoteId: fid,
        });
      }
      // Intentionally do NOT compare `arrayEntry.marker` against the sup's
      // `fn-count-id`. `marker` is a snapshot captured by batch.js at the
      // moment of the last per-node save; the renderer/reconcile path can
      // legitimately update the sup's `fn-count-id` later (during a renumber)
      // without re-running the per-node save. The two values drifting is
      // expected and harmless — the integrity verifier doesn't read marker,
      // only the rendered DOM text.

      // Map vs stored HTML — this is the divergence the integrity checker trips on
      const mapDisplay = mapByFootnoteId.get(fid);
      if (mapDisplay === undefined) {
        violations.push({
          kind: 'map_missing_id',
          startLine: node.startLine,
          footnoteId: fid,
        });
      } else if (
        /^\d+$/.test(String(mapDisplay)) &&
        /^\d+$/.test(String(htmlFnCountId)) &&
        String(mapDisplay) !== String(htmlFnCountId)
      ) {
        violations.push({
          kind: 'map_disagrees_with_html',
          startLine: node.startLine,
          footnoteId: fid,
          htmlFnCountId,
          mapDisplay,
        });
      }
    }

    // node.footnotes → content sup
    for (const fid of arrayById.keys()) {
      if (!supsById.has(fid)) {
        violations.push({
          kind: 'content_missing_id',
          startLine: node.startLine,
          footnoteId: fid,
        });
      }
    }
  }

  return violations;
}

/**
 * Convenience: snapshot everything (IDB + diag) and return the analysis.
 * Use at scenario checkpoints.
 */
export async function snapshotFootnoteState(page, bookId) {
  const [idbNodes, diag] = await Promise.all([
    dumpBookNodes(page, bookId),
    getFnDiagSnapshot(page),
  ]);
  const mapEntries = diag?.mapEntries || [];
  const violations = analyseFootnoteInvariants({ idbNodes, mapEntries });
  return { idbNodes, diag, violations };
}

/**
 * Compact human-readable report of a snapshot — easy to log in test output
 * or attach to a failed assertion.
 */
export function summariseSnapshot({ idbNodes, diag, violations }) {
  const nodesWithFootnotes = idbNodes.filter(n => n.footnotes?.length).length;
  const totalSupsInContent = idbNodes.reduce((acc, n) => acc + extractSupsFromContent(n.content).length, 0);
  const byKind = violations.reduce((acc, v) => { acc[v.kind] = (acc[v.kind] || 0) + 1; return acc; }, {});
  return {
    bookId: diag?.bookId,
    nodeCount: idbNodes.length,
    nodesWithFootnotes,
    totalSupsInContent,
    mapSize: diag?.mapEntries?.length || 0,
    rebuildCount: diag?.rebuildCount || 0,
    diagEnabled: !!diag?.enabled,
    domMutationCount: diag?.domMutations?.length || 0,
    violationCount: violations.length,
    violationsByKind: byKind,
    firstFewViolations: violations.slice(0, 8),
  };
}
