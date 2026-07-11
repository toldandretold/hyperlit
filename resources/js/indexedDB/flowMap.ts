/**
 * Flow map of the IndexedDB layer — the stage/module registry for the
 * DOM → IndexedDB → Postgres write direction and the Postgres/IndexedDB → DOM
 * read direction.
 *
 * This is the JS equivalent of app/Services/CitationPipeline/PipelineMap.php
 * and app/Python's pipeline tree: a single declared source of truth that
 * (a) feeds the generated visualisation, and (b) is drift-tested against the
 * filesystem — every module under resources/js/indexedDB must be placed here
 * exactly once, and every placement must exist on disk.
 *
 * Drift gate: tests/javascript/indexedDB/flowMap.drift.test.js
 *
 * `path` is relative to resources/js/indexedDB, WITHOUT extension, so the
 * .js → .ts migration doesn't churn this map.
 * `plain` is the human-readable one-liner that the visualisation will render —
 * write it for a reader of the diagram, not for the compiler.
 */

export interface FlowModule {
  /** Module path relative to resources/js/indexedDB, no extension. */
  path: string;
  /** One-line plain-language description (rendered in the visualisation). */
  plain: string;
}

export interface FlowStage {
  id: string;
  title: string;
  plain: string;
  modules: FlowModule[];
}

/**
 * A tier in the full data-flow stack, ordered BOTTOM → TOP
 * (DOM at the bottom, PostgreSQL at the top — the viewer picks the axis).
 * `mapped: false` tiers are placeholders: extension sockets for layers we
 * haven't decomposed/typed yet. The 'api' tier self-populates with endpoint
 * boxes extracted from the modules' real fetch()/sendBeacon calls.
 */
export interface ExternalTier {
  id: string;
  title: string;
  plain: string;
  mapped: false;
}

export const TIER_ORDER: string[] = ['dom', 'idb', 'api', 'postgres'];

export const EXTERNAL_TIERS: ExternalTier[] = [
  {
    id: 'dom',
    title: 'DOM / Editor',
    plain: 'The live contenteditable book. User edits flow up from here (divEditor saveQueue → Capture); rendered content flows back down (Hydrate → lazyLoader). Not yet mapped — next territory after the IndexedDB layer.',
    mapped: false,
  },
  {
    id: 'api',
    title: 'Laravel API',
    plain: 'HTTP boundary. Endpoint boxes below are extracted from the actual fetch()/sendBeacon calls in the mapped modules — the controllers behind them are not yet mapped.',
    mapped: false,
  },
  {
    id: 'postgres',
    title: 'PostgreSQL',
    plain: 'Server-side source of truth (node_chunks, hypercites, hyperlights, footnotes, bibliography, library tables + RLS). Not yet mapped.',
    mapped: false,
  },
];

export const FLOW_STAGES: FlowStage[] = [
  {
    id: 'capture',
    title: 'Capture',
    plain: 'Editor DOM changes become IndexedDB records (write direction).',
    modules: [
      { path: 'nodes/bookIdResolver', plain: 'Resolves which book a save belongs to: explicit option → sub-book [data-book-id] container → main-content id → global → "latest".' },
      { path: 'nodes/positionCollector', plain: 'Walks a node\'s <mark>/<u> tags into character ranges; skips zero-width residue and de-dupes by id.' },
      { path: 'nodes/contentProcessor', plain: 'Turns a live editor node into its persisted form: collects annotations/footnotes/citations, then strips marks, styles, navigation classes and render artifacts from a clone.' },
      { path: 'nodes/annotationUpserts', plain: 'Writes measured mark/u positions into the normalized hyperlight/hypercite stores: orphan recovery, _deleted_nodes cleanup, per-node charData.' },
      { path: 'nodes/batch', plain: 'Batch write orchestrator: resolves the book, reads originals, delegates to contentProcessor + annotationUpserts in one transaction, then queues sync, rebuilds arrays and triggers renumbering.' },
      { path: 'nodes/write', plain: 'Direct node writes: import/save-all, renumbering, append paths.' },
      { path: 'nodes/normalize', plain: 'Migrates a node record to a new composite key when its id changes.' },
      { path: 'nodes/delete', plain: 'Single-node delete, including orphan bookkeeping on highlights/hypercites that spanned it.' },
      { path: 'nodes/index', plain: 'Barrel for node operations.' },
    ],
  },
  {
    id: 'queue',
    title: 'Queue',
    plain: 'Edits accumulate in a debounced pending queue before being pushed.',
    modules: [
      { path: 'syncQueue/queue', plain: 'pendingSyncs map keyed `${store}-${book}-${id}`; preserves the FIRST originalData for undo; kicks the debounced master sync.' },
    ],
  },
  {
    id: 'push',
    title: 'Push',
    plain: 'IndexedDB state is pushed to Postgres via the unified sync endpoint.',
    modules: [
      { path: 'syncQueue/master', plain: 'Sync orchestrator: groups queued items by book, re-reads fresh from IDB, POSTs /api/db/unified-sync, historyLog bookkeeping, tiered 409/419/5xx handling.' },
      { path: 'syncQueue/freshNodeFilter', plain: 'Drops foreign-book rows after the node_id re-read (guards the dual-book node_id gotcha).' },
      { path: 'syncQueue/bookSyncChain', plain: 'Per-book async serialization so overlapping debounce drains never race on base_timestamp (the false-409 fix).' },
      { path: 'syncQueue/selfConflictContentCheck', plain: 'On a STALE_DATA 409, fetches the server\'s current node content and compares it to what we tried to write — recognizes a lost-ACK own-write (network committed but response dropped) so it recovers silently instead of showing the discard overlay.' },
      { path: 'syncQueue/unload', plain: 'Last-chance flush on tab close/background: sendBeacon + visibilitychange flushes.' },
      { path: 'syncQueue/index', plain: 'Barrel for the sync queue.' },
      { path: 'nodes/syncNodesToPostgreSQL', plain: 'Legacy targeted node upsert endpoint (pre-unified-sync).' },
      { path: 'footnotes/syncFootnotesToPostgreSQL', plain: 'Legacy footnote upsert endpoint.' },
      { path: 'bibliography/syncReferencesToPostgreSQL', plain: 'Legacy reference upsert endpoint.' },
      { path: 'hypercites/syncHypercitesToPostgreSQL', plain: 'Hypercite sync, including the atomic node+cite update through unified sync.' },
      { path: 'highlights/syncHighlightsToPostgreSQL', plain: 'Hyperlight upsert / delete / hide endpoints.' },
    ],
  },
  {
    id: 'serverSync',
    title: 'Server sync',
    plain: 'Pull side: fetch a book (or just its annotations) from the Laravel API and hydrate the IndexedDB stores; also the post-creation push of locally-seeded data back up. Counterpart to the Queue/Push (syncQueue) write path. Formerly the top-level postgreSQL.js.',
    modules: [
      { path: 'serverSync/pull', plain: 'Fetch book/annotations from /api/database-to-indexeddb, clear, then load all stores; delegates private/deleted-book UI out to the page-load layer.' },
      { path: 'serverSync/loaders', plain: 'Pure store-writers: parse + batch-write nodes/footnotes/bibliography/hyperlights/hypercites/library into IndexedDB.' },
      { path: 'serverSync/clear', plain: 'Clear a book (or just its annotations) from the stores; rebuild the annotations embedded inside node records.' },
      { path: 'serverSync/push', plain: 'Push IndexedDB state up to the server after new-book creation (library first, then nodes/annotations/footnotes); has the missing-chunk-0 abort guard.' },
      { path: 'serverSync/flush', plain: 'Drain the whole edit pipeline (footnote debounces → input debounce → SaveQueue → masterSync) before a destructive clear+redownload.' },
      { path: 'serverSync/index', plain: 'Barrel re-exporting the public server-sync surface.' },
      { path: 'serverSync/types', plain: 'The Postgres↔IndexedDB seam, characterized: server row shapes the loaders receive, the pull response envelopes, and the pull/push result types.' },
    ],
  },
  {
    id: 'hydrate',
    title: 'Hydrate',
    plain: 'Stored data flows back out of IndexedDB toward the DOM (read direction).',
    modules: [
      { path: 'hydration/rebuild', plain: 'Rebuilds node hyperlights/hypercites/footnotes arrays from the normalized tables — arrays are computed views, never edited in place.' },
      { path: 'nodes/read', plain: 'Node reads: whole book, single key, ranges after a node.' },
    ],
  },
  {
    id: 'domain',
    title: 'Domain stores',
    plain: 'Per-store modules for the non-node record types.',
    modules: [
      { path: 'core/library', plain: 'Library store: book metadata, content/annotation timestamps, first-node→title sync, server fetch.' },
      { path: 'footnotes/index', plain: 'Footnote store CRUD.' },
      { path: 'bibliography/index', plain: 'Bibliography store CRUD and reference-target resolution.' },
      { path: 'hypercites/index', plain: 'Hypercite store CRUD and relationship management.' },
      { path: 'hypercites/read', plain: 'Hypercite read primitive (leaf, no sibling imports — breaks the index↔helpers cycle).' },
      { path: 'hypercites/helpers', plain: 'Hypercite helper utilities.' },
      { path: 'highlights/index', plain: 'Hyperlight store CRUD.' },
    ],
  },
  {
    id: 'infra',
    title: 'Infrastructure',
    plain: 'Connection, schema, health and shared plumbing under everything above.',
    modules: [
      { path: 'core/connection', plain: 'Singleton IDB connection + the schema upgrade path (DB_VERSION); self-heals when Safari kills the connection.' },
      { path: 'core/healthMonitor', plain: 'Circuit breaker: consecutive-failure tracking, recovery loop, failed-operation queue.' },
      { path: 'core/recoveryToast', plain: 'Recovery progress toast UI.' },
      { path: 'core/utilities', plain: 'parseNodeId, composite keys, toPublicNode (the on-the-wire node shape).' },
      { path: 'utilities/cleanup', plain: 'Clear or delete a book\'s data across all stores.' },
      { path: 'utilities/retry', plain: 'Exponential-backoff retry wrapper for flaky IDB operations.' },
      { path: 'utilities/index', plain: 'Barrel for utilities.' },
      { path: 'index', plain: 'Root barrel + dependency-injection bootstrap (initializeDatabaseModules / updateDatabaseBookId).' },
      { path: 'types', plain: 'Shared record/payload types — single source of truth, pinned by the characterization tests.' },
      { path: 'flowMap', plain: 'This registry: stages + module placements + tier order feeding the generated visualisation and the drift test. (The generator itself now lives in /visualisation — visualisation/js/collect.ts.)' },
    ],
  },
];
