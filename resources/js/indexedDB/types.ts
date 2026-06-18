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
  creator?: string | null;
  preview_nodes?: unknown[] | null; // sub-book preview snippets, forwarded opaquely
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
  /** @deprecated Denormalized JSON copy of the node, slated for removal from the
   *  DB. Opaque here — node readers forward it, they don't dig into its fields.
   *  Typed so the phase-out can follow the type; do not add new readers. */
  raw_json?: unknown;
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
  // A real synced DB column (varchar). Stored/forwarded only — never read for logic — so its runtime
  // type is mixed: written as a number on create, loaded as the varchar string from getHyperlights.
  // (Per-node character ranges live in `charData`; there is no top-level start/end char.)
  startLine?: number | string | null;
  highlightedText: string;
  highlightedHTML: string;
  annotation: string;
  // Written as `... || null` for anon users (see hyperlights/database.ts), so null is a real value.
  creator?: string | null;
  /** Client-LOCAL: the anon owner token, set on create so the save can prove ownership. The server
   *  strips it on read (getHyperlights), so a server-loaded record never carries it. */
  creator_token?: string | null;
  /** Sub-book preview snippets (annotation sub-book) — opaque array forwarded to the renderer. */
  preview_nodes?: unknown[] | null;
  is_user_highlight?: boolean;
  hidden?: boolean;
  time_since?: number;
  /** @deprecated Denormalized JSON copy — phase-out (no new readers). */
  raw_json?: unknown;
}

/**
 * A row in the `hypercites` store. Key: [book, hyperciteId]. The normalized source of truth for a
 * citation (its embedded per-node render is `NodeHyperciteView` on `NodeRecord.hypercites[]`). Loaded
 * from DatabaseToIndexedDBController::getHypercites (→ ServerHyperciteRow) and saved via
 * DbHyperciteController. Per-node char ranges live in `charData` (AnnotationRecordBase).
 */
export interface HyperciteRecord extends AnnotationRecordBase {
  hyperciteId: string;
  hypercitedText?: string;
  hypercitedHTML?: string;
  citedIN: string[];
  relationshipStatus: RelationshipStatus;
  time_since?: number;
  /** Server-computed (getHypercites): creator username (null for anon) + whether it's the viewer's own. */
  creator?: string | null;
  is_user_hypercite?: boolean;
  /** @deprecated Denormalized JSON copy — phase-out (no new readers). */
  raw_json?: unknown;
}

// ── footnotes / bibliography / library stores ───────────────────────

/**
 * A row in the `footnotes` store. Key: [book, footnoteId]. The footnote's HTML body + its rendered
 * preview, loaded from DatabaseToIndexedDBController::getFootnotes (→ ServerFootnotesPayload, expanded
 * per footnoteId) and saved via DbFootnoteController. Traced by the `footnotes` type lens.
 * (The DB also has server-managed citation-matching columns — is_citation/source_id/match_* and the
 * server-set sub_book_id — which are NOT part of the client wire/store shape.)
 */
export interface FootnoteRecord {
  book: BookId;
  footnoteId: string;
  content?: string;
  /** Rendered preview snippets — an opaque array forwarded to the preview renderer. */
  preview_nodes?: unknown[] | null;
  /** ISO timestamps set client-side by the inserter / annotation save. */
  created_at?: string;
  updated_at?: string;
}

/**
 * A row in the `bibliography` store. Key: [book, referenceId]. A reference/citation: its formatted
 * content + the IDs that link it to a cited source. Loaded from
 * DatabaseToIndexedDBController::getBibliography (→ ServerBibliographyPayload, expanded per referenceId)
 * and saved via DbReferencesController. Traced by the `bibliography` type lens. (Server-managed
 * citation-matching columns — foundation_source/llm_metadata/match_* — are NOT in this client shape.)
 */
export interface BibliographyRecord {
  book: BookId;
  referenceId: string;
  content?: string;
  /** library.book of the cited version (legacy + canonical-with-version linking). */
  source_id?: string | number | null;
  /** canonical_source.id (uuid) when known (modern linking); resolved at click time. */
  canonical_source_id?: string | number | null;
  /** READ-only — derived server-side via leftJoin library.has_nodes (like library's is_owner). */
  source_has_nodes?: boolean | null;
  /** ISO timestamps set client-side by the citation inserter. */
  created_at?: string;
  updated_at?: string;
}

/**
 * The book creator's default annotation-gate flags, stored on `library.gate_defaults`
 * (jsonb). Mirrors the `custom` object of the gate filter (applyGateFilters /
 * getGatePreferences in DatabaseToIndexedDBController) — the per-book defaults a
 * reader inherits unless they override them.
 */
export interface GateDefaults {
  hideAI?: boolean;
  hideAnonymous?: boolean;
  hideNoAnnotation?: boolean;
}

/**
 * A row in the `library` store. Key: book. One book's bibliographic + display
 * metadata — loaded from DatabaseToIndexedDBController::getLibrary (→ ServerLibraryRow)
 * and saved back via DbLibraryController::upsert / bulkCreate.
 *
 * Pinned alongside serverSync's ServerLibraryRow; the two MUST agree on the wire
 * fields. Traced by the `library` type lens (visualisation TABLE_TYPES.library).
 */
export interface LibraryRecord {
  book: BookId;
  title?: string | null;
  author?: string | null;
  bibtex?: string | null;
  fileName?: string | null;
  fileType?: string | null;
  journal?: string | null;
  note?: string | null;
  pages?: string | null;
  publisher?: string | null;
  school?: string | null;
  type?: string | null;
  url?: string | null;
  year?: string | null;
  creator?: string | null;
  /** ms epoch — publication/edit time. Never null in store: set to now() on load if missing. */
  timestamp?: number;
  /** ms epoch of the last hyperlight/hypercite change (drives annotation-only sync). */
  annotations_updated_at?: number;
  visibility?: 'public' | 'private' | 'deleted';
  listed?: boolean;
  license?: string | null;
  custom_license_text?: string | null;
  gate_defaults?: GateDefaults | null;
  /** Server-computed ownership flag — present on LOAD, never sent on save. */
  is_owner?: boolean;
  /** Bibliographic sub-fields — round-trip both ways (getLibrary returns them, upsert writes them). */
  volume?: string | null;
  issue?: string | null;
  booktitle?: string | null;
  chapter?: string | null;
  editor?: string | null;
  /** @deprecated Denormalized JSON copy (mirrors the top-level fields). Slated for
   *  removal; readers forward it, they don't dig in. Do not add new readers. */
  raw_json?: unknown;
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

/**
 * Couples each sync store to the record shape it carries. This is the single
 * source of the store↔data correlation that makes SyncQueueItem a discriminated
 * union: `item.store === 'nodes'` narrows `item.data` to `NodeRecord`, etc.
 */
export interface SyncStoreRecordMap {
  nodes: NodeRecord;
  hyperlights: HyperlightRecord;
  hypercites: HyperciteRecord;
  footnotes: FootnoteRecord;
  bibliography: BibliographyRecord;
  library: LibraryRecord;
}

type SyncQueueItemFor<S extends SyncStore> = {
  store: S;
  id: string | number;
  type: SyncOperationType;
  data: SyncStoreRecordMap[S] | null;
  /** First-queued original state, preserved across re-queues (for undo). */
  originalData: SyncStoreRecordMap[S] | null;
};

/**
 * A queued sync operation. Discriminated over `store`, so a switch / `===` check
 * on `item.store` narrows `item.data` to that store's record type — no casts.
 */
export type SyncQueueItem = { [S in SyncStore]: SyncQueueItemFor<S> }[SyncStore];

/** Signature of queue.ts's queueForSync — for typing injected dependencies. */
export type QueueForSyncFn = <S extends SyncStore>(
  store: S,
  id: string | number,
  type?: SyncOperationType,
  data?: SyncStoreRecordMap[S] | Partial<SyncStoreRecordMap[S]> | null,
  originalData?: SyncStoreRecordMap[S] | Partial<SyncStoreRecordMap[S]> | null,
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
