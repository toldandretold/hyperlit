/**
 * myHighlights/ghost — display-time ghost detection for hyperlights.
 *
 * A highlight is GHOSTED when its underlying text no longer exists. Ghost-ness
 * is COMPUTED here, never stored (user decision) — the record itself is
 * untouched, and the backend StaleCharDataPruner guarantees a fully-ghosted
 * record keeps ≥1 (stale) node entry + startLine as its last-known anchor.
 *
 * Ghost-ness is about TEXT SURVIVAL, not offset validity. An entry (one
 * node's charData range) RESOLVES when the node still exists AND any of:
 *   1. the slice at the range appears inside the record's highlightedText
 *      (offsets valid — the exact fast path);
 *   2. the whole highlightedText still appears anywhere in the node (offsets
 *      drifted under edits but the text survives);
 *   3. a digit-stripped PROBE of the highlight (prefix/middle/suffix) appears
 *      in the digit-stripped node text — covers dynamic footnote renumbering
 *      (sup digits differ between the DOM, where charData was measured, and
 *      the stored content), multi-node highlights (each node holds only a
 *      fragment of highlightedText), and stale local offsets awaiting the
 *      server recalc round-trip.
 * The content requirement is what catches MID-NODE deletion — a length-only
 * test calls a highlight "live" whenever the paragraph merely remains longer
 * than charStart, even though the highlighted words are gone. Conversely, a
 * range that no longer fits must NOT alone prove ghost-ness: an edit
 * elsewhere in the node shortens it without touching the highlighted words
 * (the false-👻-on-a-visibly-alive-mark bug).
 *
 * DOM-independent: judges against IDB `nodes` store content, so it works for
 * highlights in chunks that aren't rendered. Unjudgeable cases stay LIVE:
 *   - <latex> content (KaTeX inflates live textContent — length math lies)
 *   - IDB lookup errors
 *   - empty/missing charData, or highlightedText too short to compare
 */

import type { HyperlightRecord, NodeRecord } from '../../indexedDB/types';
import { openDatabase } from '../../indexedDB/core/connection';
import { verbose } from '../../utilities/logger';

export interface GhostEntry {
  charStart: number;
  charEnd: number;
  /** null = the node no longer exists in the book. */
  nodeContent: string | null;
  /** The record's highlightedText (whole highlight, all nodes). */
  highlightedText?: string | null;
}

/** Strip tags and decode the common entities WITHOUT collapsing whitespace —
 *  offsets in charData index the DOM textContent, where entities are decoded. */
function plainTextOf(content: string): string {
  return content
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

/** Comparison form: collapse all whitespace (incl. nbsp) to single spaces. */
function comparable(s: string): string {
  return s.replace(/[\s ]+/g, ' ').trim();
}

/** Comparison form with digit runs removed: footnote sup markers are digits
 *  that DYNAMIC renumbering rewrites in the DOM (where charData and
 *  highlightedText were measured) without touching stored content — digits
 *  can't be trusted when matching the two. */
function comparableNoDigits(s: string): string {
  return comparable(s.replace(/\d+/g, ' '));
}

const PROBE_LEN = 20;

/** Probe substrings (prefix / middle / suffix) of a digit-stripped highlight.
 *  A node still containing ANY of them still holds part of the highlight. */
function buildProbes(hlNoDigits: string): string[] {
  if (hlNoDigits.length < 8) return []; // too short to be a meaningful probe
  if (hlNoDigits.length <= PROBE_LEN) return [hlNoDigits];
  const mid = Math.floor((hlNoDigits.length - PROBE_LEN) / 2);
  return [
    hlNoDigits.slice(0, PROBE_LEN),
    hlNoDigits.slice(mid, mid + PROBE_LEN),
    hlNoDigits.slice(-PROBE_LEN),
  ];
}

/** Pure. Can this entry still resolve against the node's current content? */
export function entryResolves(entry: GhostEntry): boolean {
  const { charStart, charEnd, nodeContent, highlightedText } = entry;
  // Server tombstone (CharDataRecalculator): -1/-1 = the text was DELETED —
  // deterministic ghost, no content inspection needed.
  if (charStart < 0) return false;
  if (nodeContent === null) return false;
  if (nodeContent.includes('<latex')) return true; // covers <latex> and <latex-block>

  const plain = plainTextOf(nodeContent);
  const rangeFits = charStart < plain.length && charEnd <= plain.length;

  const hlNorm = comparable(String(highlightedText ?? ''));
  if (hlNorm.length < 3) return rangeFits; // too short to judge by content — range fit decides

  // 1. Exact: the text AT the range is part of the highlight (offsets valid).
  if (rangeFits) {
    const sliceNorm = comparable(plain.slice(charStart, charEnd));
    if (sliceNorm.length > 0 && hlNorm.includes(sliceNorm)) return true;
  }

  // 2. Offsets may have shifted — or OVERRUN: an edit elsewhere in the node
  //    shortened it without touching the highlighted words. The highlight is
  //    alive if its whole text survives anywhere in the node. (A bad range
  //    alone must never prove ghost-ness — that flagged visibly-alive marks.)
  if (comparable(plain).includes(hlNorm)) return true;

  // 3. Fuzzy: digit-insensitive probes. Handles renumbered footnote sups,
  //    multi-node highlights (one node holds only a fragment of the whole
  //    highlightedText) and stale offsets awaiting the server-recalc
  //    round-trip. A false ghost on a live mark is worse than a late one —
  //    err toward live when the words are demonstrably still present.
  const plainNoDigits = comparableNoDigits(plain);
  return buildProbes(comparableNoDigits(hlNorm)).some((p) => plainNoDigits.includes(p));
}

/** Pure. Ghosted = has at least one entry AND none of them resolve. */
export function computeGhosted(entries: GhostEntry[]): boolean {
  if (entries.length === 0) return false;
  return entries.every((e) => !entryResolves(e));
}

/**
 * Look up node content by data-node-id within a book. node_id is NOT unique
 * across books in IDB (parent + sub-book can share one — see NodeRecord docs),
 * so matches are filtered to the record's book. Returns null when the node no
 * longer exists in that book.
 */
async function nodeContentById(
  db: IDBDatabase,
  book: string,
  nodeId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(nodeId);
  if (cached !== undefined) return cached;
  const content = await new Promise<string | null>((resolve) => {
    try {
      const tx = db.transaction('nodes', 'readonly');
      const idx = tx.objectStore('nodes').index('node_id');
      const req = idx.getAll(nodeId);
      req.onsuccess = () => {
        const match = (req.result as NodeRecord[]).find((n) => n.book === book);
        resolve(match ? match.content ?? '' : null);
      };
      // Lookup error → unjudgeable → resolve to a sentinel entryResolves treats as live.
      req.onerror = () => resolve('<latex>');
    } catch {
      resolve('<latex>');
    }
  });
  cache.set(nodeId, content);
  return content;
}

/**
 * Pure. Is a HYPERCITE ghosted? Cites carry a DETERMINISTIC ghost state — the
 * system maintains relationshipStatus 'ghost' (source-tag deletion, node
 * deletion tombstones) and -1/-1 charData tombstones — so no content
 * inspection is needed, unlike highlights.
 */
export function isHyperciteGhosted(record: {
  relationshipStatus?: string;
  charData?: Record<string, { charStart: number; charEnd: number }>;
}): boolean {
  if (record.relationshipStatus === 'ghost') return true;
  const entries = Object.values(record.charData ?? {});
  return entries.length > 0 && entries.every((e) => (e?.charStart ?? 0) < 0);
}

/** Is this single highlight ghosted? (One-off check — arrows/nav use this.) */
export async function isHighlightGhosted(
  record: HyperlightRecord,
  db?: IDBDatabase,
): Promise<boolean> {
  const partitioned = await partitionGhosts([record], db);
  return partitioned.ghosts.length === 1;
}

/**
 * Split records into live vs ghosted. One shared node-content cache across the
 * whole batch (highlights in the same book often share nodes).
 */
export async function partitionGhosts(
  records: HyperlightRecord[],
  db?: IDBDatabase,
): Promise<{ live: HyperlightRecord[]; ghosts: HyperlightRecord[] }> {
  const live: HyperlightRecord[] = [];
  const ghosts: HyperlightRecord[] = [];
  if (records.length === 0) return { live, ghosts };

  let database: IDBDatabase;
  try {
    database = db || await openDatabase();
  } catch {
    return { live: [...records], ghosts: [] }; // no DB → everything unjudgeable → live
  }

  const cache = new Map<string, string | null>();
  for (const record of records) {
    const charData = record.charData && typeof record.charData === 'object' ? record.charData : {};
    const nodeIds = Object.keys(charData);
    const entries: GhostEntry[] = [];
    for (const nodeId of nodeIds) {
      const range = charData[nodeId];
      if (!range || typeof range.charStart !== 'number') continue;
      entries.push({
        charStart: range.charStart,
        charEnd: typeof range.charEnd === 'number' ? range.charEnd : range.charStart,
        nodeContent: await nodeContentById(database, String(record.book), nodeId, cache),
        highlightedText: record.highlightedText,
      });
    }
    if (computeGhosted(entries)) {
      ghosts.push(record);
    } else {
      live.push(record);
    }
  }

  if (ghosts.length > 0) {
    verbose.content(
      `ghost detection: ${ghosts.length}/${records.length} highlight(s) ghosted`,
      'hyperlights/myHighlights/ghost',
    );
  }
  return { live, ghosts };
}
