/**
 * myHighlights/list — "the current user's highlights in this book, in document
 * order". Data layer only, no DOM. Feeds the hyperlit container's prev/next
 * arrows and the ghost ledger.
 *
 * The ownership test mirrors the triple check used at render sites
 * (contentBuilders/displayHyperlights.ts, contentTypes/hyperlightHandler.ts):
 * prefer the server-computed is_user_highlight flag; fall back to creator
 * name/username/email for logged-in users and creator_token for anon users
 * (only set on locally-created records — the server strips it on read).
 */

import type { BookId, HyperciteRecord, HyperlightRecord } from '../../indexedDB/types';
import { openDatabase } from '../../indexedDB/core/connection';

/** The structural fields position derivation needs — satisfied by both
 *  HyperlightRecord and HyperciteRecord (startLine is unofficial on cites). */
type Positionable = {
  book: BookId;
  node_id?: string[] | null;
  startLine?: number | string | null;
  _ghost_anchor_node?: string;
};

/** One entry of the unified "hyperlighted" list (highlights + <u> cites). */
export type OwnedAnnotation =
  | { kind: 'highlight'; record: HyperlightRecord }
  | { kind: 'hypercite'; record: HyperciteRecord };

export interface AuthIdentity {
  user: { name?: string; username?: string; email?: string } | null;
  /** Logged-in: name/username/email. Anonymous: the anon token. */
  userId: string | null;
}

/** Pure. Does this highlight belong to the given identity? */
export function isOwnedHighlight(record: HyperlightRecord, auth: AuthIdentity): boolean {
  if (record.is_user_highlight === true) return true;
  const { user, userId } = auth;
  if (user && record.creator && (
    record.creator === user.name ||
    record.creator === user.username ||
    record.creator === user.email
  )) return true;
  if (!record.creator && record.creator_token != null && record.creator_token === userId) return true;
  return false;
}

/**
 * Pure. Document order by the record's STORED startLine (varchar in PG, number
 * on local create — parseFloat both). Records without a parseable startLine
 * sort last, keeping their relative insertion order.
 *
 * NOTE: the stored startLine is only updated when the mark is RENDERED during
 * a save, so it drifts for unrendered highlights under renumbering — prefer
 * the DERIVED order (getOwnedHighlightsForBook resolves each record's nodes to
 * their CURRENT startLines; node_id is the renumber-stable identity). This
 * pure sort is the fallback when nodes can't be resolved.
 */
export function sortByDocumentOrder(records: HyperlightRecord[]): HyperlightRecord[] {
  const pos = (r: HyperlightRecord): number => {
    const n = parseFloat(String(r.startLine ?? ''));
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  return [...records].sort((a, b) => pos(a) - pos(b));
}

/** Current startLine of a node by data-node-id within a book (null = node gone). */
async function nodeStartLineById(
  db: IDBDatabase,
  book: string,
  nodeId: string,
  cache: Map<string, number | null>,
): Promise<number | null> {
  const cached = cache.get(nodeId);
  if (cached !== undefined) return cached;
  const startLine = await new Promise<number | null>((resolve) => {
    try {
      const idx = db.transaction('nodes', 'readonly').objectStore('nodes').index('node_id');
      const req = idx.getAll(nodeId);
      req.onsuccess = () => {
        const match = (req.result as Array<{ book: unknown; startLine: unknown }>)
          .find((n) => String(n.book) === book);
        const n = match ? Number(match.startLine) : NaN;
        resolve(Number.isFinite(n) ? n : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  cache.set(nodeId, startLine);
  return startLine;
}

/**
 * The record's CURRENT document position, by falling preference:
 *  1. smallest present-day startLine of its own nodes (node_id is stable
 *     across renumbering, so this never drifts);
 *  2. the ghost anchor — the surviving PRECEDING node captured at whole-node
 *     deletion time (`_ghost_anchor_node`, also renumber-proof; epsilon added
 *     so the ghost sorts just after its neighbor);
 *  3. the stored startLine (frozen at last measure — last resort).
 */
export async function resolveDocumentPosition(
  record: Positionable,
  db: IDBDatabase,
  cache: Map<string, number | null> = new Map(),
): Promise<number> {
  const nodeIds = Array.isArray(record.node_id) ? record.node_id : [];
  let best = Number.POSITIVE_INFINITY;
  for (const nodeId of nodeIds) {
    const sl = await nodeStartLineById(db, String(record.book), nodeId, cache);
    if (sl !== null && sl < best) best = sl;
  }
  if (Number.isFinite(best)) return best;

  if (record._ghost_anchor_node) {
    const anchorSl = await nodeStartLineById(db, String(record.book), record._ghost_anchor_node, cache);
    if (anchorSl !== null) return anchorSl + 0.0001;
  }

  const stored = parseFloat(String(record.startLine ?? ''));
  return Number.isFinite(stored) ? stored : Number.POSITIVE_INFINITY;
}

/**
 * The startLine the reader should NAVIGATE to for this record, as a real DOM
 * id string (must correspond to an actual node): the record's own node when
 * one still exists → the surviving ghost-anchor neighbor (renumber-proof) →
 * the stored last-known startLine (may no longer exist; internalNav's
 * nearest-preceding fallback bounds the damage). Null when nothing resolves.
 */
export async function resolveAnchorStartLine(
  record: Positionable,
  db: IDBDatabase,
): Promise<string | null> {
  const cache = new Map<string, number | null>();
  const nodeIds = Array.isArray(record.node_id) ? record.node_id : [];
  let best = Number.POSITIVE_INFINITY;
  for (const nodeId of nodeIds) {
    const sl = await nodeStartLineById(db, String(record.book), nodeId, cache);
    if (sl !== null && sl < best) best = sl;
  }
  if (Number.isFinite(best)) return String(best);

  if (record._ghost_anchor_node) {
    const anchorSl = await nodeStartLineById(db, String(record.book), record._ghost_anchor_node, cache);
    if (anchorSl !== null) return String(anchorSl);
  }

  const stored = parseFloat(String(record.startLine ?? ''));
  return Number.isFinite(stored) ? String(record.startLine) : null;
}

/**
 * Does the book still hold a REAL place for this record — one of its own
 * nodes, or its ghost anchor? The stored startLine fallback deliberately does
 * NOT count: it's a frozen guess that may point at a node that no longer
 * exists. Placeable ghosts are discoverable at their spot via the TOC
 * Hyperlights tab and the container ↑↓ arrows; only UNPLACEABLE ones need the
 * book-bottom ghost ledger as their home.
 */
export async function hasKnownPosition(record: Positionable, db: IDBDatabase): Promise<boolean> {
  const cache = new Map<string, number | null>();
  const nodeIds = Array.isArray(record.node_id) ? record.node_id : [];
  for (const nodeId of nodeIds) {
    if (await nodeStartLineById(db, String(record.book), nodeId, cache) !== null) return true;
  }
  if (record._ghost_anchor_node) {
    return (await nodeStartLineById(db, String(record.book), record._ghost_anchor_node, cache)) !== null;
  }
  return false;
}

/**
 * All of the user's visible highlights for a book, sorted in CURRENT document
 * order — positions derived from each record's nodes (renumber-stable), with
 * the stored startLine as the ghost fallback. Cursor over the
 * [book, hyperlight_id] primary key range; hidden records are excluded
 * (soft-deleted by the book owner).
 */
export async function getOwnedHighlightsForBook(
  bookId: BookId | string,
  auth: AuthIdentity,
  db?: IDBDatabase,
): Promise<HyperlightRecord[]> {
  const database = db || await openDatabase();
  const records = await new Promise<HyperlightRecord[]>((resolve, reject) => {
    const out: HyperlightRecord[] = [];
    const tx = database.transaction('hyperlights', 'readonly');
    const store = tx.objectStore('hyperlights');
    const range = IDBKeyRange.bound([bookId], [bookId, '￿']);
    const req = store.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push(cursor.value as HyperlightRecord);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });

  const owned = records.filter((r) => r.hidden !== true && isOwnedHighlight(r, auth));
  const cache = new Map<string, number | null>();
  const positioned = await Promise.all(
    owned.map(async (record) => ({ record, pos: await resolveDocumentPosition(record, database, cache) })),
  );
  return positioned.sort((a, b) => a.pos - b.pos).map((p) => p.record);
}

/** Pure. Ownership test for a hypercite: server-computed flag first (recomputed
 *  on every pull, true at local creation — covers anon), creator fallback. */
export function isOwnedHypercite(record: HyperciteRecord, auth: AuthIdentity): boolean {
  if (record.is_user_hypercite === true) return true;
  const { user } = auth;
  return Boolean(user && record.creator && record.creator === user.name);
}

/** All of the user's <u> cites for a book (any relationshipStatus, incl. ghosts). */
export async function getOwnedHypercitesForBook(
  bookId: BookId | string,
  auth: AuthIdentity,
  db?: IDBDatabase,
): Promise<HyperciteRecord[]> {
  const database = db || await openDatabase();
  const records = await new Promise<HyperciteRecord[]>((resolve, reject) => {
    const out: HyperciteRecord[] = [];
    const tx = database.transaction('hypercites', 'readonly');
    const store = tx.objectStore('hypercites');
    const range = IDBKeyRange.bound([bookId], [bookId, '￿']);
    const req = store.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push(cursor.value as HyperciteRecord);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
  return records.filter((r) => isOwnedHypercite(r, auth));
}

/**
 * The unified "everything I've hyperlighted" list: the user's highlights AND
 * <u> cites for the book, merged into one CURRENT-document-order sequence
 * (the traversal order of the container's ↑↓ arrows and the TOC tab).
 */
export async function getOwnedAnnotationsForBook(
  bookId: BookId | string,
  auth: AuthIdentity,
  db?: IDBDatabase,
): Promise<OwnedAnnotation[]> {
  const database = db || await openDatabase();
  const [highlights, hypercites] = await Promise.all([
    getOwnedHighlightsForBook(bookId, auth, database),
    getOwnedHypercitesForBook(bookId, auth, database),
  ]);
  const cache = new Map<string, number | null>();
  const entries: Array<{ entry: OwnedAnnotation; pos: number }> = [];
  for (const record of highlights) {
    entries.push({ entry: { kind: 'highlight', record }, pos: await resolveDocumentPosition(record, database, cache) });
  }
  for (const record of hypercites) {
    entries.push({ entry: { kind: 'hypercite', record }, pos: await resolveDocumentPosition(record as Positionable, database, cache) });
  }
  return entries.sort((a, b) => a.pos - b.pos).map((e) => e.entry);
}

/** The id an OwnedAnnotation is addressed by (HL_* or hypercite_*). */
export function annotationId(entry: OwnedAnnotation): string {
  return entry.kind === 'highlight' ? entry.record.hyperlight_id : entry.record.hyperciteId;
}

export interface AdjacentResult {
  record: HyperlightRecord;
  index: number;
  total: number;
}

/**
 * Pure. The neighbour of `currentId` in an ordered list. dir 1 = next,
 * -1 = previous. Null at the ends (no wrap) or when currentId is absent.
 */
export function getAdjacent(
  ordered: HyperlightRecord[],
  currentId: string,
  dir: 1 | -1,
): AdjacentResult | null {
  const idx = ordered.findIndex((r) => r.hyperlight_id === currentId);
  if (idx === -1) return null;
  const targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= ordered.length) return null;
  const record = ordered[targetIdx];
  if (!record) return null;
  return { record, index: targetIdx, total: ordered.length };
}

/** Position of `currentId` in an ordered list (for "3 / 12" UI), or null. */
export function getPosition(
  ordered: HyperlightRecord[],
  currentId: string,
): { index: number; total: number } | null {
  const idx = ordered.findIndex((r) => r.hyperlight_id === currentId);
  return idx === -1 ? null : { index: idx, total: ordered.length };
}

/** Mixed-list neighbour of `currentId` (HL_* or hypercite_*). Null at the ends. */
export function getAdjacentAnnotation(
  ordered: OwnedAnnotation[],
  currentId: string,
  dir: 1 | -1,
): { entry: OwnedAnnotation; index: number; total: number } | null {
  const idx = ordered.findIndex((e) => annotationId(e) === currentId);
  if (idx === -1) return null;
  const targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= ordered.length) return null;
  const entry = ordered[targetIdx];
  if (!entry) return null;
  return { entry, index: targetIdx, total: ordered.length };
}

/** Mixed-list position of `currentId` (for "3 / 12" UI), or null. */
export function getAnnotationPosition(
  ordered: OwnedAnnotation[],
  currentId: string,
): { index: number; total: number } | null {
  const idx = ordered.findIndex((e) => annotationId(e) === currentId);
  return idx === -1 ? null : { index: idx, total: ordered.length };
}
