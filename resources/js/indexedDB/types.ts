/**
 * Shared types for the IndexedDB layer — the single source of truth for what
 * flows DOM → IndexedDB → Postgres (and back, via hydration).
 *
 * These shapes are PINNED by tests/javascript/indexedDB/*.characterization.test.js:
 *   - store/index layout ............ schema.characterization.test.js
 *   - record shapes on write ........ batchUpdate.characterization.test.js
 *   - the unified-sync contract ..... masterSync.characterization.test.js
 *   - rebuilt view shapes ........... rebuild.characterization.test.js
 *
 * When a type here changes, a characterization test should be changing in the
 * same commit — if it isn't, the type is drifting from reality.
 *
 * Fields marked `unknown`/optional with a TODO are not yet characterized;
 * tighten them as their modules get pinned and converted.
 */

export type BookId = string;

export const DB_NAME = 'MarkdownDB';

/** Object stores in MarkdownDB (see core/connection.js ALL_STORE_CONFIGS). */
export const STORE_NAMES = [
  'nodes',
  'footnotes',
  'bibliography',
  'markdownStore',
  'hyperlights',
  'hypercites',
  'library',
  'historyLog',
] as const;
export type StoreName = (typeof STORE_NAMES)[number];

// ── Shared fragments ────────────────────────────────────────────────

export interface CharRange {
  charStart: number;
  charEnd: number;
}

/**
 * Hypercite relationship state machine (pinned in hypercites.test.js):
 * 0 citations → 'single', 1 → 'couple', ≥2 → 'poly'; 'ghost' = tombstone.
 * The `(string & {})` keeps legacy/unknown DB values assignable without
 * losing autocomplete on the known states.
 */
export type RelationshipStatus = 'single' | 'couple' | 'poly' | 'ghost' | (string & {});

/**
 * Footnote reference as carried on a node: extraction from the live DOM
 * produces `{id, marker}` objects (markers may be non-numeric: *, 23a…);
 * hydration-from-content produces bare id strings. Both occur in stored data.
 */
export type FootnoteRef = string | { id: string; marker: string };

export interface CitationRef {
  referenceId: string;
  text: string;
}

// ── nodes store ─────────────────────────────────────────────────────

/**
 * Rebuilt render view of a hyperlight on one node. NEVER edited directly —
 * always rebuilt from the normalized `hyperlights` store (hydration/rebuild.js).
 */
export interface NodeHyperlightView extends CharRange {
  highlightID: string;
  annotation?: string;
  creator?: string;
  preview_nodes?: unknown; // TODO: characterize when hyperlights module is converted
  is_user_highlight?: boolean;
  hidden?: boolean;
  time_since?: number;
}

/** Rebuilt render view of a hypercite on one node (see NodeHyperlightView). */
export interface NodeHyperciteView extends CharRange {
  hyperciteId: string;
  relationshipStatus: RelationshipStatus;
  citedIN: string[];
  time_since?: number;
}

/** A row in the `nodes` store. Key: [book, startLine]. */
export interface NodeRecord {
  book: BookId;
  startLine: number;
  chunk_id: number;
  /** data-node-id from the DOM — globally unique across books in Postgres,
   *  but NOT in IDB (parent + sub-book can share one; see the dual-book
   *  gotcha pinned in rebuild.characterization.test.js). */
  node_id: string | null;
  content: string;
  hyperlights: NodeHyperlightView[];
  hypercites: NodeHyperciteView[];
  footnotes: FootnoteRef[];
  citations?: CitationRef[];
}

// ── hyperlights / hypercites stores (normalized source of truth) ────

interface AnnotationRecordBase {
  book: BookId;
  /** data-node-ids this annotation spans (multiEntry-indexed). */
  node_id: string[];
  /** Per-node character ranges, keyed by data-node-id. */
  charData: Record<string, CharRange>;
  /** Bookkeeping for node deletion/recovery (batch.js + delete.js). */
  _orphaned_at?: number;
  _orphaned_from_node?: string;
  _deleted_nodes?: string[];
}

/** A row in the `hyperlights` store. Key: [book, hyperlight_id]. */
export interface HyperlightRecord extends AnnotationRecordBase {
  hyperlight_id: string;
  // Legacy positional schema (kept for backward compat, still written):
  startChar: number;
  endChar: number;
  startLine: number;
  highlightedText: string;
  highlightedHTML: string;
  annotation: string;
  creator?: string;
  preview_nodes?: unknown;
  is_user_highlight?: boolean;
  hidden?: boolean;
  time_since?: number;
}

/** A row in the `hypercites` store. Key: [book, hyperciteId]. */
export interface HyperciteRecord extends AnnotationRecordBase {
  hyperciteId: string;
  startChar: number;
  endChar: number;
  hypercitedText: string;
  hypercitedHTML: string;
  citedIN: string[];
  relationshipStatus: RelationshipStatus;
  time_since: number;
}

// ── footnotes / bibliography / library stores ───────────────────────

/** A row in the `footnotes` store. Key: [book, footnoteId]. TODO: tighten. */
export interface FootnoteRecord {
  book: BookId;
  footnoteId: string;
  content?: string;
  [key: string]: unknown;
}

/** A row in the `bibliography` store. Key: [book, referenceId]. TODO: tighten. */
export interface BibliographyRecord {
  book: BookId;
  referenceId: string;
  source_id?: string | number | null;
  [key: string]: unknown;
}

/** A row in the `library` store. Key: book. TODO: tighten. */
export interface LibraryRecord {
  book: BookId;
  timestamp?: number;
  title?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

// ── sync queue / history log ────────────────────────────────────────

export type SyncOperationType = 'update' | 'delete' | 'hide';

/** Stores that can be queued for sync (queue.js key: `${store}-${book}-${id}`). */
export type SyncStore =
  | 'nodes'
  | 'hyperlights'
  | 'hypercites'
  | 'footnotes'
  | 'bibliography'
  | 'library';

/** Any store record carried through the sync queue (NodeRecord, HyperlightRecord, …). */
export type SyncRecordData = { book?: BookId } & object;

export interface SyncQueueItem {
  store: SyncStore;
  id: string | number;
  type: SyncOperationType;
  data: SyncRecordData | null;
  /** First-queued original state, preserved across re-queues (for undo). */
  originalData: SyncRecordData | null;
}

/** Signature of queue.ts's queueForSync — for typing injected dependencies. */
export type QueueForSyncFn = (
  store: SyncStore,
  id: string | number,
  type?: SyncOperationType,
  data?: SyncRecordData | null,
  originalData?: SyncRecordData | null,
  skipRedoClear?: boolean,
) => void;

export type HistoryLogStatus = 'pending' | 'synced' | 'failed';

/** A row in the `historyLog` store. Key: id (autoIncrement). */
export interface HistoryLogEntry {
  id?: number;
  timestamp: number;
  bookId: BookId;
  status: HistoryLogStatus;
  payload: {
    book: BookId;
    updates: HistoryLogSide;
    deletions: HistoryLogSide;
  };
}

interface HistoryLogSide {
  nodes: PublicChunk[];
  hypercites: HyperciteRecord[];
  hyperlights: HyperlightRecord[];
  footnotes: FootnoteRecord[];
  bibliography: BibliographyRecord[];
  library: LibraryRecord | null;
}

// ── client → server contract ────────────────────────────────────────

/**
 * Public chunk format produced by toPublicChunk() — what node records look
 * like on the wire (and in historyLog payloads).
 */
export interface PublicChunk {
  book: BookId;
  startLine: number;
  node_id: string | null;
  content: string;
  hyperlights: NodeHyperlightView[];
  hypercites: NodeHyperciteView[];
  footnotes: FootnoteRef[];
  chunk_id: number;
}

type Deletion<T> = T & { _action: 'delete' | 'hide' };

/**
 * ⚠️ The exact body POSTed to /api/db/unified-sync — pinned field-for-field
 * by masterSync.characterization.test.js. Do not move a field without
 * changing the backend AND that test in the same commit.
 */
export interface UnifiedSyncPayload {
  book: BookId;
  nodes: Array<PublicChunk | Deletion<PublicChunk>>;
  hypercites: HyperciteRecord[];
  hyperlights: HyperlightRecord[];
  hyperlightDeletions: Array<Deletion<Partial<HyperlightRecord>>>;
  footnotes: FootnoteRecord[];
  footnoteDeletions: Array<Deletion<Partial<FootnoteRecord>>>;
  bibliography: BibliographyRecord[];
  bibliographyDeletions: Array<Deletion<Partial<BibliographyRecord>>>;
  library: LibraryRecord | null;
}
