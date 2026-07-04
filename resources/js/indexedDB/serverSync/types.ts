/**
 * serverSync/types — the Postgres ↔ IndexedDB network seam, characterized.
 *
 * Zero-import leaf (types only). These describe the shapes that cross the wire
 * between the Laravel API and the IndexedDB stores: the row shapes the loaders
 * receive (server rows differ from the in-store records — JSON columns arrive
 * either stringified or already decoded depending on the endpoint), the pull
 * response envelopes, and the result objects the pull/push entry points return.
 *
 * Source of truth for the envelopes: DatabaseToIndexedDBController::getBookData
 * (the `/api/database-to-indexeddb/books/{id}/data` + `/annotations` responses).
 */
import type { BookId, GateDefaults, RelationshipStatus, CharRange } from '../types';

/** A JSON column that arrives either stringified (raw endpoints) or decoded. */
type JsonColumn<T> = string | T | null;

// ── server row shapes (input to the loaders) ───────────────────────────

/** A `nodes` row as it comes from the API, before loaders normalize it. */
export interface ServerNodeRow {
  book: BookId;
  // Always a JSON number on the wire: the API casts `(float) $chunk->startLine`
  // (decimals like 100.2 are real — nodes inserted between integers). The string
  // form of a node position only exists in the DOM (element.id) and the
  // parseNodeId/createNodeKey boundary helpers, never here.
  startLine: number;
  // Required: the API's node mapping always emits these (chunk_id as (int),
  // node_id, content) — see DatabaseToIndexedDBController::getBookData.
  chunk_id: number;
  node_id: string | null;
  content: string;
  hyperlights?: JsonColumn<unknown[]>;
  hypercites?: JsonColumn<unknown[]>;
  footnotes?: JsonColumn<unknown[]>;
  /** @deprecated Denormalized copy slated for removal from the DB — do not add
   *  new readers. Tracked here so the phase-out can follow the type. */
  raw_json?: JsonColumn<object>;
}

/**
 * A standalone `hyperlights` row from the API (getHyperlights). Normalized by processHyperlight before
 * storage. MUST stay in sync with the store type `HyperlightRecord`. `creator_token` is intentionally
 * never sent (only `is_user_highlight` is exposed); `node_id` may arrive stringified.
 */
export interface ServerHyperlightRow {
  hyperlight_id: string;
  book?: BookId;
  node_id: string[] | string;
  charData?: Record<string, CharRange>;
  is_user_highlight?: boolean;
  annotation?: string;
  creator?: string | null;
  highlightedText?: string;
  highlightedHTML?: string;
  hidden?: boolean;
  preview_nodes?: unknown[] | null;
  time_since?: number;
  startLine?: number | string | null;
  /** @deprecated Denormalized copy slated for removal — do not add new readers. */
  raw_json?: JsonColumn<object>;
}

/**
 * A standalone `hypercites` row from the API (getHypercites). `node_id`/`citedIN`/`raw_json` may
 * arrive stringified (raw endpoints); `creator_token` is intentionally never sent. MUST stay in sync
 * with the store type `HyperciteRecord` (resources/js/indexedDB/types.ts).
 */
export interface ServerHyperciteRow {
  hyperciteId: string;
  book?: BookId;
  node_id: string[] | string;
  charData?: Record<string, CharRange>;
  hypercitedText?: string;
  hypercitedHTML?: string;
  relationshipStatus?: RelationshipStatus;
  citedIN?: JsonColumn<string[]>;
  creator?: string | null;
  is_user_hypercite?: boolean;
  time_since?: number;
  /** @deprecated Denormalized copy slated for removal — do not add new readers. */
  raw_json?: JsonColumn<object>;
}

/** One footnote value: new format object, or legacy bare content string. */
type ServerFootnoteValue = { content?: string; preview_nodes?: unknown[] | null } | string;
/** The `footnotes` payload: a book id plus a footnoteId→value map. */
export interface ServerFootnotesPayload {
  book: BookId;
  data: Record<string, ServerFootnoteValue>;
}

/** One bibliography value: new format object, or legacy bare content string. */
type ServerBibliographyValue =
  | { content?: string; source_id?: string | number | null; canonical_source_id?: string | number | null; source_has_nodes?: boolean | null }
  | string;
/** The `bibliography` payload: a book id plus a referenceId→value map. */
export interface ServerBibliographyPayload {
  book: BookId;
  data: Record<string, ServerBibliographyValue>;
}

/**
 * A `library` row from the API (DatabaseToIndexedDBController::getLibrary), cleaned by
 * prepareLibraryForIndexedDB into a LibraryRecord before storage. The wire fields here
 * MUST match that controller's returned array (its `@return array{...}` PHPDoc).
 *
 * `creator_token` is intentionally never sent; `is_owner` is server-computed; `gate_defaults`
 * arrives already decoded.
 */
export interface ServerLibraryRow {
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
  // bibliographic sub-fields — returned by getLibrary (symmetric with the upsert write).
  volume?: string | null;
  issue?: string | null;
  booktitle?: string | null;
  chapter?: string | null;
  editor?: string | null;
  type?: string | null;
  url?: string | null;
  year?: string | null;
  creator?: string | null;
  timestamp?: number | null;
  annotations_updated_at?: number;
  visibility?: 'public' | 'private' | 'deleted';
  listed?: boolean;
  /** E2EE (docs/e2ee.md): mirrors LibraryRecord.encrypted / wrapped_dek. */
  encrypted?: boolean;
  wrapped_dek?: string | null;
  license?: string | null;
  custom_license_text?: string | null;
  gate_defaults?: GateDefaults | null;
  is_owner?: boolean;
  /** @deprecated Denormalized copy slated for removal from the DB — do not add new readers. */
  raw_json?: JsonColumn<object>;
}

// ── pull response envelopes ─────────────────────────────────────────────

/** Response of GET /api/database-to-indexeddb/books/{id}/data. */
export interface BookDataResponse {
  nodes?: ServerNodeRow[];
  footnotes?: ServerFootnotesPayload | null;
  bibliography?: ServerBibliographyPayload | null;
  hyperlights?: ServerHyperlightRow[];
  hypercites?: ServerHyperciteRow[];
  library?: ServerLibraryRow | null;
  metadata?: unknown;
  /** Error envelopes (404/410/403) reuse this body with an `error` discriminator. */
  error?: string;
}

/** Response of GET /api/database-to-indexeddb/books/{id}/annotations. */
export interface AnnotationsResponse {
  hyperlights?: ServerHyperlightRow[];
  hypercites?: ServerHyperciteRow[];
}

// ── result objects (return values of the pull/push entry points) ─────────

/**
 * Result of syncBookDataFromDatabase / syncAnnotationsOnly.
 *
 * Discriminated on `reason` (the field consumers actually branch on): only the
 * 'sync_error' outcome carries `.error`; only the synced outcomes carry
 * `.loaded_counts`; the access outcomes carry neither. So `reason === 'sync_error'`
 * narrows `.error` into existence, and reading `.loaded_counts` off a failure is
 * a compile error — the type encodes the real protocol, not just current usage.
 */
export type PullResult =
  | { success: true; reason: 'synced_from_database'; metadata?: unknown; loaded_counts: Record<string, number> }
  | { success: true; reason: 'annotations_synced'; loaded_counts: Record<string, number> }
  | { success: false; reason: 'book_not_found' | 'book_deleted' | 'access_denied' }
  | { success: false; reason: 'sync_error'; error: string };
