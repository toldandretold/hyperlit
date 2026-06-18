/**
 * Data-flow graph generator for the front-end data layer (the JS lives in
 * /visualisation — see visualisation/README.md). Today it maps DOM ↔ IndexedDB ↔
 * the API seam; the PHP/controller tier is the planned next extension.
 *
 * Models DATA MOVEMENT across the stack the user cares about —
 *   DOM  →  (JS) IndexedDB object stores  →  (PHP) PostgreSQL tables
 * — and back. Each exported function is a node; the DOM, the IndexedDB object
 * stores, and the Postgres tables are data nodes on their own tiers. Edges are
 * directed by data direction:
 *
 *   DOM ──read──▶ fn ──write──▶ (object store) ──read──▶ fn ──push──▶ «pg table»
 *
 * The default view collapses functions into their file/module box; click a
 * module to expand its functions (handled in the HTML, not here).
 *
 * Analysis uses the TypeScript compiler (not regex): per function we resolve
 * which stores it reads (.get/.getAll/.openCursor/index) and writes
 * (.put/.add/.delete, or any readwrite transaction), which endpoints it calls
 * (fetch/sendBeacon → mapped to the real Postgres tables), and whether it
 * touches the DOM. Non-exported helpers fold into the exported caller(s).
 *
 * Output (regenerate with `npm run viz:idb`):
 *   - visualisation/generated/flowViz.generated.json ... the {nodes, modules, edges} graph
 *   - visualisation/generated/FLOWMAP.generated.md ..... per-function data-flow listing
 *   - visualisation/generated/full-stack-data-map.html . interactive cytoscape diagram
 *
 * PURE on import; only writeArtifacts() touches disk. Deterministic (no
 * Date/random) so the no-drift gate can byte-compare.
 */
/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// This generator visualises the front-end data layer, so it reads that layer's own
// metadata (stage registry, store schema, record shapes) from resources/js/indexedDB.
import { FLOW_STAGES } from '../../resources/js/indexedDB/flowMap';
import { STORE_CONFIGS, DB_VERSION } from '../../resources/js/indexedDB/core/connection';
import { DB_NAME, STORE_NAMES } from '../../resources/js/indexedDB/types';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // visualisation/js
const VIS_ROOT = path.resolve(HERE, '..');                 // visualisation
const REPO_ROOT = path.resolve(VIS_ROOT, '..');            // repo root
const RES_ROOT = path.join(REPO_ROOT, 'resources', 'js');  // resources/js — module keys are relative to here
const IDB_ROOT = path.join(RES_ROOT, 'indexedDB');         // the front-end data layer scanned for the graph

/**
 * Extra source folders analyzed alongside the IndexedDB layer: the DOM↔IndexedDB
 * mediators that read the DOM and write the stores even in read mode
 * (highlight-on-select, copy-as-hypercite) plus the editor itself (divEditor —
 * the heaviest DOM writer, mutation-observer-driven). They form the JS tier
 * between the reader page and the object stores.
 */
const EXTRA_ROOTS = [path.join(RES_ROOT, 'paste'), path.join(RES_ROOT, 'search'), path.join(RES_ROOT, 'hyperlights'), path.join(RES_ROOT, 'hypercites'), path.join(RES_ROOT, 'divEditor'), path.join(RES_ROOT, 'editToolbar'), path.join(RES_ROOT, 'footnotes'), path.join(RES_ROOT, 'citations'), path.join(RES_ROOT, 'hyperlitContainer'), path.join(RES_ROOT, 'lazyLoader'), path.join(RES_ROOT, 'scrolling'), path.join(RES_ROOT, 'pageLoad'), path.join(RES_ROOT, 'SPA'), path.join(RES_ROOT, 'components', 'cloudRef'), path.join(RES_ROOT, 'components', 'sourceContainer'), path.join(RES_ROOT, 'components', 'userButton'), path.join(RES_ROOT, 'components', 'userContainer'), path.join(RES_ROOT, 'components', 'newBookButton'), path.join(RES_ROOT, 'components', 'newbookContainer'), path.join(RES_ROOT, 'components', 'settingsButton'), path.join(RES_ROOT, 'components', 'settingsContainer'), path.join(RES_ROOT, 'components', 'editButton'), path.join(RES_ROOT, 'components', 'tocToggleButton'), path.join(RES_ROOT, 'components', 'tocContainer'), path.join(RES_ROOT, 'components', 'utilities'), path.join(RES_ROOT, 'components', 'logoNav'), path.join(RES_ROOT, 'components', 'homepage'), path.join(RES_ROOT, 'components', 'userProfile'), path.join(RES_ROOT, 'components', 'fileDropTarget'), path.join(RES_ROOT, 'components', 'floatingActionMenu'), path.join(RES_ROOT, 'components', 'saveErrorToast'), path.join(RES_ROOT, 'components', 'togglePerimeterButtons'), path.join(RES_ROOT, 'components', 'containerDragger'), path.join(RES_ROOT, 'components', 'selectionHandler'), path.join(RES_ROOT, 'components', 'toast'), path.join(RES_ROOT, 'components', 'shelves')];

/** Per-store key + index names — what each object store holds — straight from the schema. */
const STORE_SCHEMA: Record<string, { keyPath: string; indices: string[] }> = Object.fromEntries(
  STORE_CONFIGS.map(cfg => {
    const kp = Array.isArray(cfg.keyPath) ? cfg.keyPath.join(' + ') : String(cfg.keyPath);
    const indices = (cfg.indices ?? []).map(i => (typeof i === 'string' ? i : i.name));
    return [cfg.name, { keyPath: cfg.autoIncrement ? `${kp} (auto)` : kp, indices }];
  }),
);

const STORE_SET = new Set<string>(STORE_NAMES);

/**
 * Browser web-storage backends — modelled as store nodes ON THE SAME ROW as the IndexedDB object
 * stores (distinct colour), so the data tables that persist client-side WITHOUT IndexedDB
 * (`user_reading_positions`/`vibes`/`shelves`) have a real "store" waypoint instead of dead-ending.
 * Detected from `localStorage`/`sessionStorage` `.getItem`/`.setItem`/… calls (see analyzeFunctionBody).
 */
const WEB_STORAGE = ['localStorage', 'sessionStorage'];
const WEB_STORAGE_SET = new Set<string>(WEB_STORAGE);

const WRITE_OPS = new Set(['put', 'add', 'delete', 'clear']);
const READ_OPS = new Set(['get', 'getAll', 'getAllKeys', 'getKey', 'count', 'openCursor', 'openKeyCursor', 'index']);

const DOM_READ_METHODS = new Set([
  'querySelector', 'querySelectorAll', 'getElementById', 'closest', 'getAttribute',
  'matches', 'getElementsByClassName', 'getElementsByTagName', 'cloneNode',
  // selection / range / traversal APIs — DOM-walking utilities interact with the live document
  'getSelection', 'getRangeAt', 'createRange', 'createTreeWalker', 'createNodeIterator',
  'elementFromPoint', 'getBoundingClientRect',
]);
const DOM_WRITE_METHODS = new Set([
  'appendChild', 'removeChild', 'replaceChild', 'insertBefore', 'setAttribute',
  'removeAttribute', 'remove', 'append', 'prepend', 'before', 'after',
  'insertAdjacentHTML', 'replaceWith', 'execCommand',
]);
const DOM_WRITE_PROPS = new Set(['innerHTML', 'textContent', 'innerText', 'outerHTML']);

/**
 * PG tables reached through each endpoint, and the data direction.
 * Table names are the real Postgres tables (Eloquent `$table` in app/Models/ +
 * the DB::table() calls in the *Controllers): `nodes` store ↔ `nodes` table
 * (NOT node_chunks), `bibliography` store ↔ `bibliography` table (the
 * references/upsert endpoint writes DB::table('bibliography')), and
 * `canonical_source` is singular.
 */
/**
 * The real API endpoints and the EXACT data each moves — keyed by the full URL PATTERN
 * (`{}` = an interpolated segment), so sub-paths stay distinct (`…/data` ≠ `…/annotations`).
 * `group` is the data domain so the API tier can separate the author's **book content**
 * (nodes/footnotes/bibliography/library) from **annotations** (hyperlights/hypercites — others'
 * metadata, loaded/saved on their own paths). `sync` = the bundled save that ships everything.
 * Each becomes a `route` node between the TS function and the Postgres tables it carries.
 */
interface EndpointMap { dir: 'push' | 'pull'; tables: string[]; group: 'content' | 'annotations' | 'sync'; }
const CORE_TABLES = ['nodes', 'hypercites', 'hyperlights', 'footnotes', 'bibliography', 'library'];
const ENDPOINT_TABLES: Record<string, EndpointMap> = {
  // ── book LOAD (pull) — the author's content vs the separate annotations path ──
  '/api/database-to-indexeddb/books/{}/data':        { dir: 'pull', tables: CORE_TABLES, group: 'content' },        // full book (incl. embedded annotations)
  '/api/database-to-indexeddb/books/{}/initial':     { dir: 'pull', tables: [...CORE_TABLES, 'user_reading_positions'], group: 'content' }, // fast first chunk — ALSO embeds the reading-position bookmark
  '/api/database-to-indexeddb/books/{}/annotations': { dir: 'pull', tables: ['hyperlights', 'hypercites'], group: 'annotations' }, // metadata only, loaded separately
  '/api/database-to-indexeddb/books/{}/headings':    { dir: 'pull', tables: ['nodes'], group: 'content' },          // TOC, derived from nodes
  '/api/database-to-indexeddb/books/{}/library':     { dir: 'pull', tables: ['library'], group: 'content' },
  // ── book SAVE (push) ──
  '/api/db/unified-sync':                 { dir: 'push', tables: CORE_TABLES, group: 'sync' },   // the bundled save (everything)
  '/api/db/sync/beacon':                  { dir: 'push', tables: CORE_TABLES, group: 'sync' },
  '/api/db/node-chunks/targeted-upsert':  { dir: 'push', tables: ['nodes'], group: 'content' },
  '/api/db/footnotes/upsert':             { dir: 'push', tables: ['footnotes'], group: 'content' },
  '/api/db/references/upsert':            { dir: 'push', tables: ['bibliography'], group: 'content' },
  '/api/db/hyperlights/upsert':           { dir: 'push', tables: ['hyperlights'], group: 'annotations' },
  '/api/db/hyperlights/delete':           { dir: 'push', tables: ['hyperlights'], group: 'annotations' },
  '/api/db/hyperlights/hide':             { dir: 'push', tables: ['hyperlights'], group: 'annotations' },
  '/api/db/hypercites/upsert':            { dir: 'push', tables: ['hypercites'], group: 'annotations' },
  '/api/db/hypercites/find':              { dir: 'pull', tables: ['hypercites'], group: 'annotations' },
  '/api/canonical':                       { dir: 'push', tables: ['canonical_source'], group: 'content' },
  // ── non-content tables that still ship data to the client (no IndexedDB transit) ──
  '/api/database-to-indexeddb/books/{}/reading-position': { dir: 'push', tables: ['user_reading_positions'], group: 'content' }, // scroll bookmark save
  '/api/vibes':                           { dir: 'pull', tables: ['vibes'], group: 'content' },   // css-override presets (mine/public/save)
  '/api/shelves':                         { dir: 'pull', tables: ['shelves'], group: 'content' }, // user book-collections (list/render/items/search)
};

/**
 * The TS type lineage for a Postgres table's row data — the named types it
 * takes on as it moves PG ↔ IndexedDB ↔ DOM (wire-in → store → wire-out, plus
 * the embedded annotation views). Drives the "trace node data" lens: a function
 * is tagged with whichever of these its signature/body references, so clicking a
 * table lights the functions that actually handle its data, in code order.
 *
 * Scope: `nodes` only for now (its lineage is fully welded + verified). Add the
 * other stores' lineages here to extend the lens. The values double as the
 * capture whitelist (NODE_DATA_TYPE_SET) so fn `types` stay small + meaningful.
 */
const TABLE_TYPES: Record<string, string[]> = {
  nodes: ['NodeRecord', 'ServerNodeRow', 'PublicChunk', 'NodeHyperlightView', 'NodeHyperciteView'],
  // library: wire-in (ServerLibraryRow, from getLibrary) → IDB store + save (LibraryRecord).
  library: ['ServerLibraryRow', 'LibraryRecord'],
  // footnotes: wire payload-map (ServerFootnotesPayload) → expanded per-row store/save (FootnoteRecord).
  footnotes: ['ServerFootnotesPayload', 'FootnoteRecord'],
  // bibliography: wire payload-map (ServerBibliographyPayload) → expanded per-row store/save (BibliographyRecord).
  bibliography: ['ServerBibliographyPayload', 'BibliographyRecord'],
  // hypercites: dual representation — standalone store/wire (HyperciteRecord/ServerHyperciteRow) +
  // the embedded per-node view (NodeHyperciteView, SHARED with nodes — the rebuild/clear builders are
  // the seam, so they light for both pg:hypercites and pg:nodes).
  hypercites: ['ServerHyperciteRow', 'HyperciteRecord', 'NodeHyperciteView'],
  // hyperlights: same dual shape — standalone (HyperlightRecord/ServerHyperlightRow) + the embedded
  // NodeHyperlightView (shared with nodes).
  hyperlights: ['ServerHyperlightRow', 'HyperlightRecord', 'NodeHyperlightView'],
  // ── non-content tables (fetch → DOM; no IndexedDB store) — a single API-contract type each ──
  // user_reading_positions: the scroll bookmark (ReadingPosition), saved by scrolling/ + read on load.
  user_reading_positions: ['ReadingPosition'],
  // canonical_source: the click-time best-version response (CanonicalBestVersion) resolved by the
  // bibliography resolver — citation identity, no IDB store of its own.
  canonical_source: ['CanonicalBestVersion'],
  // vibes: css-override presets — the gallery contract (Vibe) + the save body (VibeInput).
  vibes: ['Vibe', 'VibeInput'],
  // shelves: user book-collections — the list/membership contract (Shelf). (ShelfItem exists in
  // types.ts for the junction but isn't a FE-consumed entity, so it's not traced.)
  shelves: ['Shelf'],
};
const NODE_DATA_TYPE_SET = new Set<string>(Object.values(TABLE_TYPES).flat());

// ── shapes ──────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  kind: 'fn' | 'store' | 'table' | 'dom' | 'route' | 'controller';
  /** route + controller nodes: data domain — 'content' (author) | 'annotations' (others' metadata) | 'sync'. */
  group?: 'content' | 'annotations' | 'sync';
  /** route + controller nodes: 'pull' (data FROM backend / load) | 'push' (data TO backend / save). */
  dir?: 'push' | 'pull';
  /** controller nodes only: the Postgres tables it touches + the row-shape keys it builds (from the PHP collector). */
  tables?: string[];
  shape?: string[];
  /** controller nodes only: the owning controller class (the collapsible "folder") + the bare method name. */
  cls?: string;
  method?: string;
  /** flow-map stage for fn nodes (clusters the layout); undefined for data nodes. */
  stage?: string;
  /** owning module (file) key for fn nodes — drives collapse-to-module grouping. */
  module?: string;
  /** fn nodes only: true if it has no data edge (pure helper / orchestration). */
  leaf?: boolean;
  /** data-record type names this node carries: fn nodes = referenced in its
   *  signature/body; table nodes = its row-data lineage (TABLE_TYPES). Drives the
   *  type-trace lens. */
  types?: string[];
}

/** A file/module — the default (collapsed) box; expands to its function nodes. */
export interface GraphModule {
  id: string;
  label: string;
  stage: string;
  /**
   * Data-movement role, derived from the module's edges (NOT its folder):
   *  - 'capture' = touches the DOM (DOM↔IndexedDB layer)
   *  - 'sync'    = pushes/pulls Postgres (IndexedDB↔Postgres layer)
   *  - 'store'   = store-only CRUD / pure helper (the IndexedDB layer itself)
   *  - 'components' = a `components/` UI module — laid out as its own band
   *    directly above the DOM (it drives the DOM most directly), regardless of
   *    what it touches.
   */
  band: 'capture' | 'sync' | 'store' | 'components';
  fnIds: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** read | write | push | pull | domread | domwrite | call */
  rel: string;
  label?: string;
  /** call edges only: true when the callee is on a path to a store/Postgres sink — i.e. this
   *  call hands a payload toward saved data, so the flow lens shows it as a data hand-off. */
  dataPath?: boolean;
}

export interface FlowViz {
  meta: {
    dbName: string;
    dbVersion: number;
    fnCount: number;
    moduleCount: number;
    storeCount: number;
    tableCount: number;
    edgeCount: number;
    sources: string[];
    note: string;
  };
  /** stage ids in write→read order — used to lay functions out in columns. */
  stageOrder: string[];
  legend: { rel: string; from: string; to: string; desc: string }[];
  /** per-store key + index names (what each object store holds), from STORE_CONFIGS. */
  storeSchema: Record<string, { keyPath: string; indices: string[] }>;
  nodes: GraphNode[];
  modules: GraphModule[];
  edges: GraphEdge[];
  /** module→module dependency edges, classified static / breaker (dynamic cycle-breaker = debt) /
   *  lazy (dynamic non-cycle = code-split). Drives the honest "find circular deps" + lazy-load view. */
  importEdges: { source: string; target: string; kind: 'static' | 'breaker' | 'lazy' }[];
  /** staticCycles = real TDZ rings (static imports only). latentCycles = rings that appear when the
   *  dynamic cycle-breakers are treated as static — the structural debt those `await import()`s mask.
   *  + counts of the two dynamic-import kinds. */
  cycleSummary: { staticCycles: string[][]; latentCycles: string[][]; breakerCount: number; lazyCount: number };
}

// ── per-function analysis (raw, pre-fold) ───────────────────────────

interface FnRaw {
  id: string;
  name: string;
  module: string;
  exported: boolean;
  reads: Set<string>;
  writes: Set<string>;
  endpoints: Set<string>;
  domRead: boolean;
  domWrite: boolean;
  /** resolved callee fn ids (best-effort). */
  calls: Set<string>;
  /** whitelisted data-record type names referenced in the fn's signature/body. */
  types: string[];
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, c => walk(c, visit));
}

/**
 * Collect the whitelisted TS type names a function's declaration REFERENCES —
 * anywhere in its signature OR body (params, return, local annotations, `as`
 * casts, generic args). Walks `TypeReferenceNode`s only (so value identifiers
 * aren't caught) and keeps the rightmost name for qualified types. Deterministic:
 * deduped + sorted. Empty when the fn touches none of the whitelist.
 */
function collectTypeReferences(declNode: ts.Node, whitelist: Set<string>): string[] {
  const found = new Set<string>();
  walk(declNode, n => {
    if (ts.isTypeReferenceNode(n)) {
      const name = ts.isQualifiedName(n.typeName) ? n.typeName.right.text : n.typeName.text;
      if (whitelist.has(name)) found.add(name);
    }
  });
  return [...found].sort();
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

/**
 * Reconstruct a URL string/pattern from a fetch/sendBeacon argument — including template
 * literals, where each `${…}` becomes a `{}` placeholder so the segments AFTER the
 * interpolation survive. `/api/…/books/${id}/data` → "/api/…/books/{}/data" (distinct from
 * "…/annotations"); a plain string returns verbatim. Used only for endpoint detection.
 */
function urlPatternOf(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += '{}' + span.literal.text;
    return s;
  }
  return null;
}

/** Resolve `objectStore(x)` arg to a store name (literal, or const-in-scope). */
function resolveStoreArg(arg: ts.Node | undefined, body: ts.Node): string | null {
  const lit = stringLiteralValue(arg);
  if (lit) return lit;
  if (arg && ts.isIdentifier(arg)) {
    let found: string | null = null;
    walk(body, n => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === arg.text) {
        const v = stringLiteralValue(n.initializer);
        if (v) found = v;
      }
    });
    return found;
  }
  return null;
}

function classifyStoreOp(osCall: ts.CallExpression, body: ts.Node, hasReadWrite: boolean): Set<'read' | 'write'> {
  const dirs = new Set<'read' | 'write'>();
  const addOp = (op: string) => {
    if (WRITE_OPS.has(op)) dirs.add('write');
    else if (READ_OPS.has(op)) dirs.add('read');
  };
  const parent = osCall.parent;
  if (parent && ts.isPropertyAccessExpression(parent)) {
    addOp(parent.name.text); // chained: objectStore("x").get(...)
  } else if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const v = parent.name.text;
    walk(body, n => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === v) {
        addOp(n.name.text);
      }
    });
  }
  // A readwrite transaction is intent-to-write the stores it touches (covers
  // cursor-deletes and var-aliased writes the op scan can miss).
  if (hasReadWrite) dirs.add('write');
  if (dirs.size === 0) dirs.add('read');
  return dirs;
}

function normalizeEndpoint(url: string): string {
  return url.replace(/\$\{[^}]*\}.*$/, '').replace(/[?].*$/, '').replace(/\/+$/, '');
}

function analyzeFunctionBody(body: ts.Node, moduleBodies?: Map<string, ts.Node>): Omit<FnRaw, 'id' | 'name' | 'module' | 'exported' | 'types'> {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const endpoints = new Set<string>();
  const calls = new Set<string>();
  let domRead = false;
  let domWrite = false;
  let sawFetch = false;

  let hasReadWrite = false;
  walk(body, n => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'transaction') {
      if (stringLiteralValue(n.arguments[1]) === 'readwrite') hasReadWrite = true;
    }
  });

  walk(body, n => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text;
      if (m === 'objectStore') {
        const store = resolveStoreArg(n.arguments[0], body);
        if (store && STORE_SET.has(store)) {
          for (const d of classifyStoreOp(n, body, hasReadWrite)) (d === 'write' ? writes : reads).add(store);
        }
      }
      if (DOM_READ_METHODS.has(m)) domRead = true;
      if (DOM_WRITE_METHODS.has(m)) domWrite = true;
      if ((m === 'add' || m === 'remove' || m === 'toggle')
        && ts.isPropertyAccessExpression(n.expression.expression)
        && n.expression.expression.name.text === 'classList') domWrite = true;
      // localStorage/sessionStorage.<op>(…) → a web-storage read/write (modelled as a store node).
      if (ts.isIdentifier(n.expression.expression) && WEB_STORAGE_SET.has(n.expression.expression.text)) {
        const ws = n.expression.expression.text;
        if (m === 'getItem' || m === 'key') reads.add(ws);
        else if (m === 'setItem' || m === 'removeItem' || m === 'clear') writes.add(ws);
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const fnName = ts.isIdentifier(callee) ? callee.text : (ts.isPropertyAccessExpression(callee) ? callee.name.text : null);
      if (ts.isIdentifier(callee)) calls.add(callee.text);
      // fetch (bare or obj.fetch) and sendBeacon: scan the function body for the /api/ URL. A body
      // walk (not just arguments[0]) catches the URL even when it's a template literal or wrapped in
      // a helper like appendGateParam(`/api/…`) — the shape the entire load/pull side uses, which
      // previously yielded NO endpoints (hence zero pull edges; tables looked like pure sinks).
      if (fnName === 'fetch' || fnName === 'sendBeacon') {
        sawFetch = true;
        walk(body, b => { const s = urlPatternOf(b); if (s && s.startsWith('/api/')) endpoints.add(normalizeEndpoint(s)); });
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
      if (DOM_WRITE_PROPS.has(n.left.name.text)) domWrite = true;
      if (n.left.name.text === 'dataset' || (ts.isPropertyAccessExpression(n.left.expression) && n.left.expression.name.text === 'dataset')) domWrite = true;
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'objectStoreNames') {
      for (const s of STORE_NAMES) writes.add(s);
    }
    if (ts.isArrayLiteralExpression(n) && n.elements.length > 0) {
      const names = n.elements.map(e => stringLiteralValue(e)).filter((x): x is string => !!x);
      if (names.length === n.elements.length && names.every(s => STORE_SET.has(s))) for (const s of names) writes.add(s);
    }
  });

  // A fn that fetches but builds its `/api/…` URL in a same-module helper (e.g. buildPositionUrl,
  // buildApiUrl) has no inline literal — follow each called helper ONE level and adopt its endpoint,
  // so the fn gets its route edge (and thus connects to the PG table) instead of floating.
  if (sawFetch && moduleBodies) {
    for (const c of calls) {
      const hb = moduleBodies.get(c);
      if (hb && hb !== body) walk(hb, b => { const s = urlPatternOf(b); if (s && s.startsWith('/api/')) endpoints.add(normalizeEndpoint(s)); });
    }
  }

  return { reads, writes, endpoints, domRead, domWrite, calls };
}

// ── module parsing: functions + import map ──────────────────────────

/** Re-exports a barrel performs: `export { X as Y } from './m'` (named) + `export * from './m'` (stars). */
interface Reexports { named: Map<string, string>; stars: string[]; }
interface ModuleParse {
  functions: FnRaw[];
  importMap: Map<string, string>;
  reexports: Reexports;
  /** module keys this module depends on via runtime STATIC `import … from` (excl `import type`)
   *  + static re-exports (`export … from`, `export * from`). The TDZ-relevant graph. */
  staticDeps: Set<string>;
  /** module keys this module pulls in via `await import()` / `import()` (deferred — TDZ-safe). */
  dynDeps: Set<string>;
}

/**
 * Module-to-module dependency edges, by import kind. Used by the map's cycle detector to tell a
 * real (static-import) ring — which can crash with a TDZ "Cannot access X before initialization" —
 * apart from the codebase's deliberate dynamic-import cycle-breakers and plain lazy-loads.
 */
function extractModuleDeps(sf: ts.SourceFile, fromAbs: string, known: Set<string>): { staticDeps: Set<string>; dynDeps: Set<string> } {
  const staticDeps = new Set<string>();
  const dynDeps = new Set<string>();
  walk(sf, n => {
    // static value imports (skip `import type …`)
    if (ts.isImportDeclaration(n)) {
      if (n.importClause?.isTypeOnly) return;
      const t = resolveSpecToModule(fromAbs, stringLiteralValue(n.moduleSpecifier) ?? '', known);
      if (t) staticDeps.add(t);
    }
    // static re-exports `export … from './m'` / `export * from './m'` (skip `export type`)
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && !n.isTypeOnly) {
      const t = resolveSpecToModule(fromAbs, stringLiteralValue(n.moduleSpecifier) ?? '', known);
      if (t) staticDeps.add(t);
    }
    // dynamic import() — deferred to call time
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const t = resolveSpecToModule(fromAbs, stringLiteralValue(n.arguments[0]) ?? '', known);
      if (t) dynDeps.add(t);
    }
  });
  return { staticDeps, dynDeps };
}

function moduleKeyOf(abs: string): string {
  return path.relative(RES_ROOT, abs).replace(/\.(js|ts)$/, '').split(path.sep).join('/');
}

function resolveSpecToModule(fromAbs: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  // strip an explicit .js/.ts extension — module keys are extensionless, but specifiers may
  // carry `.js` (e.g. `../indexedDB/index.js`), which must still match `indexedDB/index`.
  const key = path.relative(RES_ROOT, path.resolve(path.dirname(fromAbs), spec))
    .split(path.sep).join('/').replace(/\.(js|ts)$/, '');
  if (known.has(key)) return key;
  // Bare-directory import (e.g. `../lazyLoader`) → resolve to the folder's barrel
  // (`lazyLoader/index`). Without this, cross-folder edges through barrels imported by
  // bare directory name were silently dropped, hiding real static-import cycles.
  if (known.has(`${key}/index`)) return `${key}/index`;
  return null;
}

function buildImportMap(sf: ts.SourceFile, fromAbs: string, known: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  const add = (local: string, exported: string, moduleKey: string | null) => { if (moduleKey) map.set(local, `${moduleKey}:${exported}`); };
  walk(sf, n => {
    if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      const spec = stringLiteralValue(n.moduleSpecifier);
      const moduleKey = spec ? resolveSpecToModule(fromAbs, spec, known) : null;
      for (const el of n.importClause.namedBindings.elements) add(el.name.text, (el.propertyName ?? el.name).text, moduleKey);
    }
    if (ts.isVariableDeclaration(n) && n.name && ts.isObjectBindingPattern(n.name) && n.initializer) {
      let spec: string | null = null;
      walk(n.initializer, c => { if (ts.isCallExpression(c) && c.expression.kind === ts.SyntaxKind.ImportKeyword) spec = stringLiteralValue(c.arguments[0]); });
      const moduleKey = spec ? resolveSpecToModule(fromAbs, spec, known) : null;
      if (moduleKey) for (const el of n.name.elements) {
        if (ts.isIdentifier(el.name)) add(el.name.text, ((el.propertyName && ts.isIdentifier(el.propertyName)) ? el.propertyName.text : el.name.text), moduleKey);
      }
    }
  });
  return map;
}

/**
 * Extract a module's re-export declarations so barrels (e.g. `indexedDB/index`) can be
 * followed to the real definition: `export { updateSingleIndexedDBRecord } from './nodes/batch'`
 * maps `indexedDB/index:updateSingleIndexedDBRecord` → `indexedDB/nodes/batch:updateSingleIndexedDBRecord`.
 */
function buildReexports(sf: ts.SourceFile, fromAbs: string, known: Set<string>): Reexports {
  const named = new Map<string, string>();
  const stars: string[] = [];
  walk(sf, n => {
    if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const spec = stringLiteralValue(n.moduleSpecifier);
      const target = spec ? resolveSpecToModule(fromAbs, spec, known) : null;
      if (!target) return;
      if (!n.exportClause) { stars.push(target); }                       // export * from './m'
      else if (ts.isNamedExports(n.exportClause)) {                       // export { A, B as C } from './m'
        for (const el of n.exportClause.elements) {
          named.set(el.name.text, `${target}:${(el.propertyName ?? el.name).text}`);
        }
      }
    }
  });
  return { named, stars };
}

function parseModule(abs: string, known: Set<string>): ModuleParse {
  const src = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.ES2022, true);
  const moduleKey = moduleKeyOf(abs);
  const importMap = buildImportMap(sf, abs, known);
  const functions: FnRaw[] = [];
  // declNode = the whole declaration (params/return + body), so collectTypeReferences
  // sees signature AND body type annotations; body is what analyzeFunctionBody walks.
  // Two-pass: collect every fn (incl. non-exported URL-builder helpers like buildPositionUrl/
  // buildApiUrl), THEN analyze with a name→body map so a fetch/sendBeacon fn can pick up the
  // `/api/…` URL even when it's built in a helper it calls (else the fn has no route edge).
  const decls: { name: string; exported: boolean; body: ts.Node; declNode: ts.Node }[] = [];
  const record = (name: string, exported: boolean, body: ts.Node, declNode: ts.Node) => {
    decls.push({ name, exported, body, declNode });
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      record(stmt.name.text, isExported(stmt), stmt.body, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      const exported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) && ts.isIdentifier(decl.name)) {
          record(decl.name.text, exported, decl.initializer.body, decl.initializer);
        }
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      // Class-per-file modules (e.g. editToolbar): treat each method/constructor and each
      // arrow-property handler as a function node `ClassName.method`, so OO code's data flow
      // (store writes, DOM, fetch) is visible — not just top-level `export function`s.
      // A class's methods are its public data-flow surface — record them as nodes even if the
      // class itself isn't `export`ed (e.g. EditToolbar, exposed only via factory functions).
      const cls = stmt.name.text;
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body && member.name && ts.isIdentifier(member.name)) {
          record(`${cls}.${member.name.text}`, true, member.body, member);
        } else if (ts.isConstructorDeclaration(member) && member.body) {
          record(`${cls}.constructor`, true, member.body, member);
        } else if (ts.isPropertyDeclaration(member) && member.initializer && member.name && ts.isIdentifier(member.name)
            && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) {
          record(`${cls}.${member.name.text}`, true, member.initializer.body, member.initializer);
        }
      }
    }
  }
  const moduleBodies = new Map<string, ts.Node>();
  for (const d of decls) moduleBodies.set(d.name, d.body);
  for (const d of decls) {
    functions.push({ id: `${moduleKey}:${d.name}`, name: d.name, module: moduleKey, exported: d.exported, ...analyzeFunctionBody(d.body, moduleBodies), types: collectTypeReferences(d.declNode, NODE_DATA_TYPE_SET) });
  }
  const { staticDeps, dynDeps } = extractModuleDeps(sf, abs, known);
  return { functions, importMap, reexports: buildReexports(sf, abs, known), staticDeps, dynDeps };
}

// ── backend (Laravel/PHP) tier ──────────────────────────────────────
//
// The PHP collector (visualisation/php/collect.php) statically parses routes/api.php + the Db*/
// DatabaseToIndexedDB controllers and emits backend.generated.json: one `controller` node per
// Controller@method on a data route, with the Postgres tables it touches (DERIVED from each Pg*
// model's $table + raw DB::table/SQL literals — not hand-coded). We stitch each controller BETWEEN
// its route node and the PG tables, so the map reads end-to-end DOM↔TS↔route↔controller↔table.

interface BackendControllerNode {
  id: string; label: string; kind: 'controller';
  dir: 'push' | 'pull'; controller: string; method: string;
  tables: string[]; shape: string[]; endpoints: string[];
}
interface BackendGraphFile {
  nodes: BackendControllerNode[];
  edges: { source: string; target: string; rel: string }[];
  endpointToController: Record<string, string>;
  modelTable: Record<string, string>;
}

const BACKEND_ARTIFACT = path.join(VIS_ROOT, 'generated', 'backend.generated.json');

function loadBackendGraph(): BackendGraphFile | null {
  if (!fs.existsSync(BACKEND_ARTIFACT)) return null;       // PHP step hasn't run (e.g. Node-only CI) → skip the tier
  try { return JSON.parse(fs.readFileSync(BACKEND_ARTIFACT, 'utf8')) as BackendGraphFile; }
  catch { return null; }
}

function backendGroup(tables: string[], url: string): 'content' | 'annotations' | 'sync' {
  if (/unified-sync|beacon/.test(url)) return 'sync';
  const ann = new Set(['hyperlights', 'hypercites']);
  return tables.length && tables.every(t => ann.has(t)) ? 'annotations' : 'content';
}

/**
 * Mutates the front-end graph in place: attach the backend controller tier at the route seam.
 * Only controllers sitting on a route the front end actually calls are shown, so every controller
 * completes a real path. The frontend's route↔table edges for those routes are rerouted through the
 * controller (controller tables = its own static set UNIONed with the route's declared tables, so
 * cross-controller delegation like unified-sync never loses coverage).
 */
function mergeBackendTier(
  nodes: GraphNode[], edges: GraphEdge[], edgeKey: Set<string>,
  routesSeen: Map<string, EndpointMap>, tablesSeen: Set<string>,
): void {
  const backend = loadBackendGraph();
  if (!backend) return;

  const nodeIds = new Set(nodes.map(n => n.id));
  const routeKeys = new Set(routesSeen.keys());            // endpoint URLs the front end's data layer fetches
  // Show EVERY data-spine controller (the allowlist already scopes them) — they're part of the full
  // stack whether or not the reader's data layer happens to hit that endpoint. Those on a detected
  // route get the full fn→route→controller→table chain; the rest still show controller→table.
  const kept = backend.nodes;

  // routes that gain a controller — their direct route↔table edges get rerouted through it
  const controllerRoutes = new Set<string>();
  for (const c of kept) for (const u of c.endpoints) if (routeKeys.has(u)) controllerRoutes.add(u);

  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i]!;
    const rt = e.source.startsWith('route:') ? e.source : e.target.startsWith('route:') ? e.target : null;
    const pg = e.source.startsWith('pg:') ? e.source : e.target.startsWith('pg:') ? e.target : null;
    if (rt && pg && controllerRoutes.has(rt.slice('route:'.length))) { edgeKey.delete(e.id); edges.splice(i, 1); }
  }

  const addEdge = (source: string, target: string, rel: string) => {
    const id = `${source}__${rel}__${target}`;
    if (edgeKey.has(id)) return;
    edgeKey.add(id);
    edges.push({ id, source, target, rel });
  };

  for (const c of kept) {
    const myRoutes = c.endpoints.filter(u => routeKeys.has(u));
    // never lose the route's declared tables (covers cross-controller delegation, e.g. unified-sync)
    const tables = [...new Set([...c.tables, ...myRoutes.flatMap(u => routesSeen.get(u)!.tables)])].sort();

    const cls = c.label.split('@')[0] ?? c.controller;   // display class, the collapsible "folder"
    nodes.push({
      id: c.id, label: c.method, kind: 'controller', dir: c.dir, cls, method: c.method,
      group: backendGroup(tables, myRoutes[0] ?? ''),
      ...(tables.length ? { tables } : {}),
      ...(c.shape.length ? { shape: c.shape } : {}),
      ...(tables.includes('nodes') ? { types: [...(TABLE_TYPES.nodes ?? [])].sort() } : {}),  // light up in the `nodes` type-trace
    });
    nodeIds.add(c.id);

    for (const u of myRoutes) {
      const routeId = `route:${u}`;
      // pull: pg → controller → route → fn ; push: fn → route → controller → pg (one consistent flow direction)
      if (c.dir === 'pull') addEdge(c.id, routeId, 'pull');
      else addEdge(routeId, c.id, 'push');
    }
    for (const t of tables) {
      const pg = `pg:${t}`;
      if (!nodeIds.has(pg)) {                               // backend-only table (e.g. user_reading_positions) → add its box
        nodes.push({ id: pg, label: t, kind: 'table', ...(TABLE_TYPES[t] ? { types: [...TABLE_TYPES[t]].sort() } : {}) });
        nodeIds.add(pg); tablesSeen.add(t);
      }
      if (c.dir === 'pull') addEdge(pg, c.id, 'pull');
      else addEdge(c.id, pg, 'push');
    }
  }
}

// ── the collector ───────────────────────────────────────────────────

export function collect(): FlowViz {
  // Module keys are relative to resources/js, so flowMap's indexedDB-relative
  // paths gain an `indexedDB/` prefix here.
  const stageOf = new Map<string, { id: string; title: string }>();
  for (const stage of FLOW_STAGES) for (const m of stage.modules) stageOf.set(`indexedDB/${m.path}`, { id: stage.id, title: stage.title });

  /** flow-map stage for indexedDB modules; folder name for the DOM↔IDB mediators. */
  const stageIdOf = (key: string): string =>
    stageOf.get(key)?.id
    ?? (key.startsWith('hyperlights/') ? 'hyperlights'
      : key.startsWith('hypercites/') ? 'hypercites'
      : key.startsWith('divEditor/') ? 'divEditor'
      : key.startsWith('editToolbar/') ? 'editToolbar'
      : key.startsWith('footnotes/') ? 'footnotes'
      : key.startsWith('citations/') ? 'citations'
      : key.startsWith('hyperlitContainer/') ? 'hyperlitContainer'
      : key.startsWith('lazyLoader/') ? 'lazyLoader'
      : key.startsWith('scrolling/') ? 'scrolling'
      : key.startsWith('pageLoad/') ? 'pageLoad'
      : key.startsWith('SPA/') ? 'SPA'
      : key.startsWith('components/') ? 'components'
      : 'infra');

  /** A module is analyzed if it's a flow-map indexedDB module or lives in a mediator folder. */
  const isAnalyzed = (key: string): boolean =>
    stageOf.has(key) || key.startsWith('hyperlights/') || key.startsWith('hypercites/') || key.startsWith('divEditor/') || key.startsWith('editToolbar/') || key.startsWith('footnotes/') || key.startsWith('citations/') || key.startsWith('hyperlitContainer/') || key.startsWith('lazyLoader/') || key.startsWith('scrolling/') || key.startsWith('pageLoad/') || key.startsWith('SPA/') || key.startsWith('components/') || key.startsWith('search/') || key.startsWith('paste/');

  const allFiles: string[] = [];
  const rec = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (/\.(js|ts)$/.test(e.name)) allFiles.push(full);
    }
  };
  rec(IDB_ROOT);
  for (const r of EXTRA_ROOTS) rec(r);
  const known = new Set(allFiles.map(moduleKeyOf));

  const fnReg = new Map<string, FnRaw>();
  const importMaps = new Map<string, Map<string, string>>();
  const reexportsByModule = new Map<string, Reexports>();
  const staticDepsByModule = new Map<string, Set<string>>();
  const dynDepsByModule = new Map<string, Set<string>>();
  for (const abs of allFiles) {
    const key = moduleKeyOf(abs);
    if (!isAnalyzed(key)) continue;
    const parsed = parseModule(abs, known);
    importMaps.set(key, parsed.importMap);
    reexportsByModule.set(key, parsed.reexports);
    staticDepsByModule.set(key, parsed.staticDeps);
    dynDepsByModule.set(key, parsed.dynDeps);
    for (const fn of parsed.functions) fnReg.set(fn.id, fn);
  }

  // Resolve a `module:name` to the real fn definition, FOLLOWING barrel re-exports
  // (`export { X } from './m'` / `export * from './m'`). This is what connects DOM-layer
  // code (editToolbar, etc.) to the indexedDB functions it calls through `indexedDB/index`.
  const resolveExport = (fnId: string, seen = new Set<string>()): string | null => {
    if (fnReg.has(fnId)) return fnId;
    if (seen.has(fnId)) return null;
    seen.add(fnId);
    const ci = fnId.indexOf(':');
    if (ci < 0) return null;
    const mod = fnId.slice(0, ci), name = fnId.slice(ci + 1);
    const rx = reexportsByModule.get(mod);
    if (!rx) return null;
    const named = rx.named.get(name);
    if (named) { const r = resolveExport(named, seen); if (r) return r; }
    for (const star of rx.stars) { const r = resolveExport(`${star}:${name}`, seen); if (r) return r; }
    return null;
  };

  for (const fn of fnReg.values()) {
    const imap = importMaps.get(fn.module);
    const resolved = new Set<string>();
    for (const name of fn.calls) {
      const viaImport = imap?.get(name);
      const r = viaImport ? resolveExport(viaImport) : null;
      if (r) resolved.add(r);
      else if (fnReg.has(`${fn.module}:${name}`)) resolved.add(`${fn.module}:${name}`);
    }
    fn.calls = resolved;
  }

  interface Folded { reads: Set<string>; writes: Set<string>; endpoints: Set<string>; domRead: boolean; domWrite: boolean; exportedCalls: Set<string>; }
  function fold(fnId: string): Folded {
    const seen = new Set<string>();
    const out: Folded = { reads: new Set(), writes: new Set(), endpoints: new Set(), domRead: false, domWrite: false, exportedCalls: new Set() };
    const stack = [fnId];
    let first = true;
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const f = fnReg.get(cur);
      if (!f) continue;
      if (!first && f.exported) { out.exportedCalls.add(cur); continue; }
      first = false;
      f.reads.forEach(s => out.reads.add(s));
      f.writes.forEach(s => out.writes.add(s));
      f.endpoints.forEach(e => out.endpoints.add(e));
      if (f.domRead) out.domRead = true;
      if (f.domWrite) out.domWrite = true;
      for (const c of f.calls) { const cf = fnReg.get(c); if (cf?.exported) out.exportedCalls.add(c); else stack.push(c); }
    }
    return out;
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const tablesSeen = new Set<string>();
  const routesSeen = new Map<string, EndpointMap>();   // matched endpoint key → its map (for route nodes)
  const edgeKey = new Set<string>();
  const pushEdge = (source: string, target: string, rel: string, label?: string, dataPath?: boolean) => {
    const id = `${source}__${rel}__${target}`;
    if (edgeKey.has(id)) return;
    edgeKey.add(id);
    edges.push({ id, source, target, rel, ...(label ? { label } : {}), ...(dataPath ? { dataPath: true } : {}) });
  };

  const exportedFns = [...fnReg.values()].filter(f => f.exported).sort((a, b) => a.id.localeCompare(b.id));
  interface FnView { fn: FnRaw; folded: Folded; hasData: boolean; }
  const fnViews: FnView[] = exportedFns.map(fn => {
    const folded = fold(fn.id);
    const hasData = folded.reads.size > 0 || folded.writes.size > 0 || folded.endpoints.size > 0 || folded.domRead || folded.domWrite;
    return { fn, folded, hasData };
  });

  // Stage 1 data-flow: does this fn (transitively, via calls) reach a STORE or Postgres endpoint?
  // A call edge to such a fn is a "data hand-off" — a hop on the path to saved data.
  const foldedById = new Map<string, Folded>(fnViews.map(v => [v.fn.id, v.folded]));
  const sinkMemo = new Map<string, boolean>();
  const reachesSink = (id: string, stack: Set<string> = new Set()): boolean => {
    const cached = sinkMemo.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return false;            // cycle back-edge: don't loop (don't memoize)
    stack.add(id);
    const f = foldedById.get(id);
    let r = !!f && (f.reads.size > 0 || f.writes.size > 0 || f.endpoints.size > 0);
    if (!r && f) for (const c of f.exportedCalls) { if (reachesSink(c, stack)) { r = true; break; } }
    stack.delete(id);
    sinkMemo.set(id, r);
    return r;
  };

  for (const { fn, folded } of fnViews) {
    folded.reads.forEach(s => pushEdge(`store:${s}`, fn.id, 'read'));
    folded.writes.forEach(s => pushEdge(fn.id, `store:${s}`, 'write'));
    if (folded.domRead) pushEdge('dom', fn.id, 'domread');
    if (folded.domWrite) pushEdge(fn.id, 'dom', 'domwrite');
    for (const ep of folded.endpoints) {
      const key = Object.keys(ENDPOINT_TABLES).filter(k => ep === k || ep.startsWith(k)).sort((a, b) => b.length - a.length)[0];
      const m = key ? ENDPOINT_TABLES[key] : undefined;
      if (!key || !m) continue;
      // Route the data THROUGH the API endpoint node: fn ↔ route ↔ table. So the graph shows the
      // real seam (which endpoint carries which data), not a fn wired straight to a guessed table.
      const routeId = `route:${key}`;
      routesSeen.set(key, m);
      if (m.dir === 'push') pushEdge(fn.id, routeId, 'push', ep);
      else pushEdge(routeId, fn.id, 'pull', ep);
      for (const t of m.tables) {
        tablesSeen.add(t);
        if (m.dir === 'push') pushEdge(routeId, `pg:${t}`, 'push', ep);
        else pushEdge(`pg:${t}`, routeId, 'pull', ep);
      }
    }
    for (const c of folded.exportedCalls) pushEdge(fn.id, c, 'call', undefined, reachesSink(c));
  }

  for (const { fn, hasData } of fnViews) {
    nodes.push({ id: fn.id, label: fn.name, kind: 'fn', stage: stageIdOf(fn.module), module: fn.module, leaf: !hasData, ...(fn.types.length ? { types: fn.types } : {}) });
  }
  for (const s of STORE_NAMES) nodes.push({ id: `store:${s}`, label: s, kind: 'store' });
  for (const s of WEB_STORAGE) nodes.push({ id: `store:${s}`, label: s, kind: 'store' }); // localStorage/sessionStorage (same row, diff colour)
  const tables = [...tablesSeen].sort();
  for (const t of tables) nodes.push({ id: `pg:${t}`, label: t, kind: 'table', ...(TABLE_TYPES[t] ? { types: [...TABLE_TYPES[t]].sort() } : {}) });
  // API endpoint tier: one node per matched route, between the TS functions and the PG tables,
  // tagged with its data-domain group. Label = the path minus /api/, `{}` → :id.
  for (const key of [...routesSeen.keys()].sort()) {
    const m = routesSeen.get(key)!;
    // concise label = the last two meaningful path segments (drop `api`, `{}` placeholders),
    // e.g. `…/books/{}/data` → "books/data", `/api/db/unified-sync` → "db/unified-sync".
    const label = key.split('/').filter(s => s && s !== 'api' && s !== '{}').slice(-2).join('/');
    nodes.push({ id: `route:${key}`, label, kind: 'route', group: m.group, dir: m.dir });
  }
  nodes.push({ id: 'dom', label: 'reader.blade.php', kind: 'dom' });

  // Backend tier: stitch the Laravel controllers onto the route nodes (no-op if the PHP step
  // hasn't produced backend.generated.json — the committed artifacts still carry the merged tier).
  mergeBackendTier(nodes, edges, edgeKey, routesSeen, tablesSeen);

  // Per-module data-movement role, aggregated from its functions' (folded) edges.
  const agg = new Map<string, { pg: boolean; dom: boolean; store: boolean }>();
  for (const { fn, folded } of fnViews) {
    const a = agg.get(fn.module) ?? { pg: false, dom: false, store: false };
    if (folded.endpoints.size) a.pg = true;
    if (folded.domRead || folded.domWrite) a.dom = true;
    if (folded.reads.size || folded.writes.size) a.store = true;
    agg.set(fn.module, a);
  }
  const bandOf = (moduleId: string): GraphModule['band'] => {
    // components sit in their own DOM-adjacent band, whatever they touch.
    if (moduleId.startsWith('components/')) return 'components';
    const a = agg.get(moduleId);
    if (a?.pg) return 'sync';       // ships data IndexedDB → Postgres
    if (a?.dom) return 'capture';   // bridges DOM ↔ IndexedDB
    return 'store';                 // store-only CRUD / pure helper
  };

  const moduleMap = new Map<string, GraphModule>();
  for (const { fn } of fnViews) {
    let mod = moduleMap.get(fn.module);
    if (!mod) { mod = { id: fn.module, label: fn.module, stage: stageIdOf(fn.module), band: bandOf(fn.module), fnIds: [] }; moduleMap.set(fn.module, mod); }
    mod.fnIds.push(fn.id);
  }
  const modules = [...moduleMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  modules.forEach(m => m.fnIds.sort());

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  // ── module-level IMPORT graph: real (static) cycles vs intentional dynamic breakers ──
  // Cycle TRUTH is computed over ALL analyzed modules — INCLUDING pure barrels like
  // `hypercites/index` (`export *`, no own functions) which carry the re-export edges that
  // close real rings. Rendered import edges (below) stay between modules that have nodes.
  const analyzedModules = new Set(staticDepsByModule.keys());
  const liveModules = new Set(modules.map(m => m.id));
  const staticAdj = new Map<string, Set<string>>();
  for (const m of analyzedModules) {
    const deps = new Set<string>();
    for (const d of staticDepsByModule.get(m) ?? []) if (analyzedModules.has(d)) deps.add(d);
    staticAdj.set(m, deps);
  }
  // Tarjan SCC over an arbitrary module adjacency → components of size ≥ 2 (cycles).
  const sccsOf = (adj: Map<string, Set<string>>): string[][] => {
    const out: string[][] = [];
    let idx = 0; const stack: string[] = []; const onStack = new Set<string>();
    const index = new Map<string, number>(); const low = new Map<string, number>();
    const strongconnect = (v: string): void => {
      index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v);
      for (const w of adj.get(v) ?? []) {
        if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
        else if (onStack.has(w)) { low.set(v, Math.min(low.get(v)!, index.get(w)!)); }
      }
      if (low.get(v) === index.get(v)) {
        const comp: string[] = []; let w: string;
        do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) out.push(comp.sort());
      }
    };
    for (const v of [...adj.keys()].sort()) if (!index.has(v)) strongconnect(v);
    return out.sort((a, b) => a.join().localeCompare(b.join()));
  };
  // REAL rings (static imports only) — the TDZ risk.
  const staticCycles = sccsOf(staticAdj);
  // Does `from` reach `to` along static-import edges? (for classifying dynamic edges)
  const staticReaches = (from: string, to: string): boolean => {
    const seen = new Set<string>(); const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nx of staticAdj.get(cur) ?? []) {
        if (nx === to) return true;
        if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
      }
    }
    return false;
  };
  // Classify every dynamic import edge across ALL analyzed modules (the HUD truth):
  //   breaker = dynamic import that WOULD close a static ring (target already reaches back here
  //             statically) → structural debt; lazy = dynamic, no cycle → genuine code-split.
  // Collect the breaker back-edges so we can reveal the rings they MASK (latentCycles).
  let breakerCount = 0, lazyCount = 0;
  const latentAdj = new Map<string, Set<string>>();
  for (const [m, ds] of staticAdj) latentAdj.set(m, new Set(ds));
  for (const m of analyzedModules) {
    for (const d of dynDepsByModule.get(m) ?? []) {
      if (!analyzedModules.has(d) || staticAdj.get(m)?.has(d)) continue; // static dominates
      if (staticReaches(d, m)) { breakerCount++; (latentAdj.get(m) ?? latentAdj.set(m, new Set()).get(m)!).add(d); }
      else lazyCount++;
    }
  }
  // LATENT rings: treat the dynamic cycle-breakers as if they were static → the structural cycles
  // the `await import()`s are masking (would crash as TDZ if made static). The real coupling debt.
  const latentCycles = sccsOf(latentAdj);
  // Rendered import edges: only between modules that have nodes (barrels without functions aren't
  // drawn). source/target are module ids; `kind` styles them (static solid / breaker / lazy dashed).
  const importEdges: { source: string; target: string; kind: 'static' | 'breaker' | 'lazy' }[] = [];
  for (const m of [...liveModules].sort()) {
    for (const d of [...(staticAdj.get(m) ?? [])].sort()) if (liveModules.has(d)) importEdges.push({ source: m, target: d, kind: 'static' });
    for (const d of [...(dynDepsByModule.get(m) ?? [])].sort()) {
      if (!liveModules.has(d) || staticAdj.get(m)?.has(d)) continue;
      importEdges.push({ source: m, target: d, kind: staticReaches(d, m) ? 'breaker' : 'lazy' });
    }
  }

  return {
    meta: {
      dbName: DB_NAME, dbVersion: DB_VERSION,
      fnCount: fnViews.length, moduleCount: modules.length, storeCount: STORE_NAMES.length + WEB_STORAGE.length, tableCount: tables.length,
      edgeCount: edges.length,
      sources: ['exported functions (TS AST)', 'indexedDB layer + hyperlights/hypercites/divEditor (DOM↔IDB modules)', 'core/connection STORE_CONFIGS', 'real fetch/sendBeacon → PG tables (Eloquent $table names)', 'flowMap.ts (stage clustering)'],
      note: 'GENERATED by visualisation/js/collect.ts — do not edit. Run `npm run viz:idb`.',
    },
    stageOrder: [...FLOW_STAGES.map(s => s.id), 'hyperlights', 'hypercites', 'divEditor', 'editToolbar', 'footnotes', 'citations', 'hyperlitContainer', 'lazyLoader', 'scrolling', 'pageLoad', 'SPA', 'components'],
    legend: [
      { rel: 'read', from: 'store', to: 'fn', desc: 'function reads an IndexedDB object store' },
      { rel: 'write', from: 'fn', to: 'store', desc: 'function writes an IndexedDB object store' },
      { rel: 'push', from: 'fn', to: 'table', desc: 'function pushes to a Postgres table (POST, via PHP)' },
      { rel: 'pull', from: 'table', to: 'fn', desc: 'function pulls from Postgres (GET, via PHP)' },
      { rel: 'domread', from: 'dom', to: 'fn', desc: 'function reads the DOM' },
      { rel: 'domwrite', from: 'fn', to: 'dom', desc: 'function writes the DOM' },
      { rel: 'call', from: 'fn', to: 'fn', desc: 'function calls another (coupling lens)' },
      { rel: 'handoff', from: 'fn', to: 'fn', desc: 'call that carries data toward a store/server (shown in the flow lens)' },
    ],
    storeSchema: STORE_SCHEMA,
    nodes, modules, edges,
    importEdges,
    cycleSummary: { staticCycles, latentCycles, breakerCount, lazyCount },
  };
}

// ── markdown renderer ───────────────────────────────────────────────

export function renderMarkdown(viz: FlowViz): string {
  const fns = viz.nodes.filter(n => n.kind === 'fn');
  const out = new Map<string, { reads: string[]; writes: string[]; push: string[]; pull: string[]; dom: string[] }>();
  for (const f of fns) out.set(f.id, { reads: [], writes: [], push: [], pull: [], dom: [] });
  const labelOf = (id: string) => id.replace(/^store:|^pg:/, '');
  for (const e of viz.edges) {
    if (e.rel === 'read' && out.has(e.target)) out.get(e.target)!.reads.push(labelOf(e.source));
    if (e.rel === 'write' && out.has(e.source)) out.get(e.source)!.writes.push(labelOf(e.target));
    if (e.rel === 'push' && out.has(e.source)) out.get(e.source)!.push.push(labelOf(e.target));
    if (e.rel === 'pull' && out.has(e.target)) out.get(e.target)!.pull.push(labelOf(e.source));
    if (e.rel === 'domread' && out.has(e.target)) out.get(e.target)!.dom.push('read');
    if (e.rel === 'domwrite' && out.has(e.source)) out.get(e.source)!.dom.push('write');
  }

  const L: string[] = [];
  L.push('<!-- GENERATED by visualisation/js/collect.ts — do not edit. Run `npm run viz:idb`. -->');
  L.push('');
  L.push('# Full-stack data map — Hyperlit');
  L.push('');
  L.push(`**${viz.meta.dbName}** schema v${viz.meta.dbVersion} · ` +
    `${viz.meta.fnCount} functions in ${viz.meta.moduleCount} modules · ` +
    `${viz.meta.storeCount} object stores · ${viz.meta.tableCount} PG tables · ${viz.meta.edgeCount} edges`);
  L.push('');
  L.push('Data moves DOM (bottom) → functions → IndexedDB object stores → PostgreSQL tables (top), via JS here and PHP at the API seam. Interactive (collapse/expand by module): `visualisation/generated/full-stack-data-map.html`.');
  L.push('');
  L.push('## Functions — what data each moves');
  L.push('');
  L.push('| Function | Module | Reads (store) | Writes (store) | DOM | Postgres |');
  L.push('|----------|--------|---------------|----------------|-----|----------|');
  const fmt = (a: string[]) => a.length ? [...new Set(a)].sort().map(x => `\`${x}\``).join(' ') : '—';
  for (const f of fns.sort((a, b) => (a.module! + a.label).localeCompare(b.module! + b.label))) {
    const o = out.get(f.id)!;
    const pg = [...new Set([...o.push.map(t => `↑${t}`), ...o.pull.map(t => `↓${t}`)])].sort().map(x => `\`${x}\``).join(' ') || '—';
    const dom = [...new Set(o.dom)].sort().join('/') || '—';
    L.push(`| \`${f.label}\` | \`${f.module}\` | ${fmt(o.reads)} | ${fmt(o.writes)} | ${dom} | ${pg} |`);
  }
  L.push('');
  // Import-cycle truth: real static rings (TDZ risk) vs intentional dynamic imports.
  const cs = viz.cycleSummary;
  L.push('## Import cycles & dynamic imports');
  L.push('');
  L.push(`**Static-import cycles (TDZ crash risk): ${cs.staticCycles.length}** · ` +
    `cycles masked by a dynamic import: ${cs.latentCycles.length} · ` +
    `dynamic cycle-breakers (debt): ${cs.breakerCount} · lazy-loads (code-split): ${cs.lazyCount}`);
  L.push('');
  L.push('Only *static-import* rings can crash with a TDZ "Cannot access X before initialization". ' +
    'A **cycle-breaker** is a back-edge deferred to runtime with `await import()` because a static import ' +
    'there would form a ring — so it does not crash, but the **masked cycle** is still real coupling debt ' +
    '(a bidirectional dependency that ideally becomes one-way via events/DI). A **lazy-load** is a dynamic ' +
    'import with no cycle (genuine code-splitting — the JS-loading-optimisation surface).');
  L.push('');
  if (cs.staticCycles.length) {
    L.push('### Static-import rings (break these — they crash)');
    for (const c of cs.staticCycles) L.push(`- ${c.map(m => `\`${m}\``).join(' ↔ ')}`);
    L.push('');
  }
  if (cs.latentCycles.length) {
    L.push('### Cycles masked by dynamic imports (coupling debt)');
    L.push('These are acyclic *only* because a back-edge is deferred with `await import()`; the modules form one bidirectional tangle:');
    for (const c of cs.latentCycles) L.push(`- (${c.length} modules) ${c.map(m => `\`${m}\``).join(', ')}`);
    L.push('');
  }
  const byKind = (k: string) => viz.importEdges.filter(e => e.kind === k).map(e => `\`${e.source}\` → \`${e.target}\``);
  const breakers = byKind('breaker'), lazies = byKind('lazy');
  if (breakers.length) { L.push('### Dynamic cycle-breakers (debt — could become one-way via events/DI)'); for (const s of breakers) L.push(`- ${s}`); L.push(''); }
  if (lazies.length) { L.push('### Lazy-loads (code-split points)'); for (const s of lazies) L.push(`- ${s}`); L.push(''); }

  L.push('## Legend');
  L.push('');
  for (const l of viz.legend) L.push(`- **${l.rel}** (${l.from} → ${l.to}): ${l.desc}`);
  L.push('');
  return L.join('\n') + '\n';
}

// ── html renderer (interactive cytoscape graph, collapse-by-module) ──
// NB: the embedded <script> avoids backticks and ${} so this outer template
// literal only interpolates ${data}.

// Database glyph (Bootstrap Icons "database", bake in a light fill so it shows on the dark nodes)
// embedded as a base64 data-URI so the generated HTML stays self-contained / offline.
const DB_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#e9eefb" viewBox="0 0 16 16"><path d="M4.318 2.687C5.234 2.271 6.536 2 8 2s2.766.27 3.682.687C12.644 3.125 13 3.627 13 4c0 .374-.356.875-1.318 1.313C10.766 5.729 9.464 6 8 6s-2.766-.27-3.682-.687C3.356 4.875 3 4.373 3 4c0-.374.356-.875 1.318-1.313M13 5.698V7c0 .374-.356.875-1.318 1.313C10.766 8.729 9.464 9 8 9s-2.766-.27-3.682-.687C3.356 7.875 3 7.373 3 7V5.698c.271.202.58.378.904.525C4.978 6.711 6.427 7 8 7s3.022-.289 4.096-.777A5 5 0 0 0 13 5.698M14 4c0-1.007-.875-1.755-1.904-2.223C11.022 1.289 9.573 1 8 1s-3.022.289-4.096.777C2.875 2.245 2 2.993 2 4v9c0 1.007.875 1.755 1.904 2.223C4.978 15.71 6.427 16 8 16s3.022-.289 4.096-.777C13.125 14.755 14 14.007 14 13zm-1 4.698V10c0 .374-.356.875-1.318 1.313C10.766 11.729 9.464 12 8 12s-2.766-.27-3.682-.687C3.356 10.875 3 10.373 3 10V8.698c.271.202.58.378.904.525C4.978 9.71 6.427 10 8 10s3.022-.289 4.096-.777A5 5 0 0 0 13 8.698m0 3V13c0 .374-.356.875-1.318 1.313C10.766 14.729 9.464 15 8 15s-2.766-.27-3.682-.687C3.356 13.875 3 13.373 3 13v-1.302c.271.202.58.378.904.525C4.978 12.71 6.427 13 8 13s3.022-.289 4.096-.777c.324-.147.633-.323.904-.525"/></svg>';
const DB_ICON_URI = 'data:image/svg+xml;base64,' + Buffer.from(DB_ICON_SVG, 'utf8').toString('base64');

export function renderHtml(viz: FlowViz): string {
  const data = JSON.stringify(viz);
  return `<!doctype html>
<!-- GENERATED by visualisation/js/collect.ts — do not edit. Run \`npm run viz:idb\`. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Full-stack data map — Hyperlit</title>
<script src="vendor/cytoscape.min.js"></script>
<style>
  :root{--bg:#0f1117;--panel:#171a23;--line:#2a3040;--text:#e6e9ef;--dim:#8b93a7;}
  *{box-sizing:border-box;} html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
  #top{position:fixed;top:0;left:0;right:0;height:54px;display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid var(--line);background:var(--panel);z-index:5;}
  #top h1{font-size:15px;margin:0;font-weight:600;} #top .meta{color:var(--dim);font-size:12px;} #top .spacer{flex:1;}
  #top button,#top select{background:#1e2230;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;}
  #top button:hover{border-color:#5eb0ef;}
  #cy{position:fixed;top:54px;left:0;right:300px;bottom:0;}
  #side{position:fixed;top:54px;right:0;bottom:0;width:300px;border-left:1px solid var(--line);background:var(--panel);padding:14px 16px;overflow:auto;}
  #side h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 8px;}
  .legend div{display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px;}
  .legend .sw{width:22px;border-top-width:3px;border-top-style:solid;}
  #hint{color:var(--dim);font-size:12px;margin-top:10px;}
  #detail{margin-bottom:14px;} #detail .name{font-family:ui-monospace,monospace;color:#5eb0ef;font-size:14px;word-break:break-all;}
  #detail .sub{color:var(--dim);font-size:11px;font-family:ui-monospace,monospace;margin-bottom:8px;}
  #detail .dirbadge{display:inline-block;font-size:10px;color:#cfe0ff;background:#1e2a40;border:1px solid #34507a;border-radius:5px;padding:2px 7px;margin:0 0 8px;}
  #detail h3{font-size:10px;text-transform:uppercase;color:var(--dim);letter-spacing:.05em;margin:12px 0 3px;}
  #detail ul{margin:2px 0;padding-left:16px;} #detail li{font-family:ui-monospace,monospace;font-size:11px;} #detail .none{color:var(--dim);font-style:italic;}
  #detail .empty{color:var(--dim);font-style:italic;font-size:12px;}
  #helpBlock{margin-top:14px;border-top:1px solid var(--line);padding-top:10px;}
  #helpBlock>summary{cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);list-style:none;outline:none;}
  #helpBlock>summary::-webkit-details-marker{display:none;}
  #helpBlock>summary:before{content:"\\25B8  ";} #helpBlock[open]>summary:before{content:"\\25BE  ";}
  #helpBlock h2{margin-top:12px;}
</style>
</head>
<body>
<div id="top">
  <h1>Full-stack data map</h1>
  <span class="meta" id="meta"></span>
  <span class="spacer"></span>
  <label class="meta" title="follow a Postgres table's data TYPE through the real code (PG↔IndexedDB↔DOM) — the same trace you get by clicking the table on the map">trace data type <select id="focus"></select></label>
  <label class="meta" title="how deep the map is unfolded — min: one box per top-level folder · default: one box per module · max: every function. Double-click any box to drill further.">detail <select id="zoomLevel"><option value="min">min</option><option value="default" selected>default</option><option value="max">max</option></select></label>
  <button id="toggleCalls" title="show which functions call which — the code's internal wiring (coupling/modularity), a different lens from data flow">show code coupling</button>
  <button id="findCycles" title="IMPORT graph: red = real static-import cycles (TDZ risk to break); orange dashed = intentional dynamic cycle-breakers (debt); teal dashed = lazy-loads (fine)">find circular deps</button>
  <button id="lazyBtn" title="highlight the lazy-loads — dynamic imports with NO cycle = genuine code-split points (deferred chunks), the JS-loading-optimisation surface">lazy-loads</button>
  <button id="traceDirBtn" title="flow lens: which direction a click traces. Nothing selected = the whole save/load pipeline.">trace: where it goes ▸</button>
  <button id="fit">fit</button>
</div>
<div id="cy"></div>
<div id="side">
  <p id="modehint" style="margin:0 0 12px;padding:7px 9px;background:#1e2230;border:1px solid var(--line);border-radius:6px;font-weight:600;">DATA FLOW — lines = data moving: store reads/writes, server push/pull, DOM, + <span style="color:#5fb3a3">teal call-hops</span> that carry data toward a store/server.</p>
  <div id="detail"></div>
  <details id="helpBlock">
  <summary>legend &amp; how to read this</summary>
  <h2>Legend</h2>
  <div class="legend" id="legend"></div>
  <p id="hint"><b>Vertical position = what the code actually does</b> (read from its data edges, not its folder). Bottom→top: the page (<b>reader.blade.php</b>) ▸ code that bridges page↔IndexedDB ▸ the <b>IndexedDB</b> object stores ▸ code that bridges IndexedDB↔server ▸ <b>PostgreSQL</b> tables.<br><br><b>Horizontal column = source folder</b> (distinguished by colour): <b style="color:#9aa6bd">indexedDB</b>, <b style="color:#3fb6b6">hyperlights</b>, <b style="color:#caa14b">hypercites</b>, <b style="color:#5e8fd6">divEditor</b>. So each box's <i>column</i> is its folder and its <i>row</i> is what it does. A box sitting in a row that doesn't match its folder's natural role (e.g. a <i>hyperlights</i> file up in the IndexedDB-store row) = code acting out of role — a candidate to move when restructuring.<br><br><b>Detail level</b> (top-bar dropdown): <i>min</i> shows one box per top-level folder, <i>default</i> one box per module, <i>max</i> every function. <b>Double-click</b> a folder box to drill into its modules, a module box into its functions (and again to collapse). Changing the level keeps your current selection lit.<br><br><b>Single-click</b> to trace — and what it traces depends on the lens. In the <b>data-flow</b> lens it follows the data from there, stopping when it lands in a store/table/the page. The <b>trace:</b> button flips direction — <i>where it goes</i> (downstream) / <i>where it comes from</i> (upstream) / <i>both</i> — and re-applies live. With <b>nothing selected</b>, that button lights the whole pipeline: <i>where it goes</i> = the save flow (DOM→IndexedDB→Postgres), <i>where it comes from</i> = the load flow (Postgres→IndexedDB→DOM). Selecting a store/table/DOM itself expands from it (what reads/writes it). In the <b>coupling</b> lens it follows the <b>full dependency reach</b> (every module this one transitively touches), and <b style="color:#ff4d4f">red edges</b> mark a <b>feedback loop</b> — the path returns to where it started (a circular dependency). The rest dims but stays visible. <b>Double-click a module box</b> to drill into its files (and again to collapse). <b>Navigate:</b> scroll to zoom, drag the canvas to pan (nodes don't drag), <i>fit</i> to reset. Click a line or empty space to clear a trace.<br><br>The <b>show code coupling</b> button flips the whole map to a second lens: lines become <i>which function calls which</i> (the code's internal wiring); orange = a call crossing folders (modules reaching into each other).<br><br>The <b>find circular deps</b> button flips to the <b>IMPORT</b> lens (module→module dependencies) and tells the truth about cycles: <b style="color:#ff4d4f">red</b> = a <b>real static-import ring</b> (the only kind that risks a TDZ "Cannot access X before initialization" crash — break these); <b style="color:#e0a44b">orange dashed</b> = a <b>dynamic-import cycle-breaker</b> — a back-edge that <i>would</i> form a static ring, deferred to runtime with <code>await import()</code> (safe, but structural debt: a bidirectional import that ideally becomes one-way via events/DI); <b style="color:#5fb3a3">teal dashed</b> = a <b>lazy-load</b> — a dynamic import with no cycle (genuine code-splitting, fine). The <b>lazy-loads</b> button isolates just those teal edges — your JS-loading-optimisation surface (what's deferred into separate chunks).</p>
  </details>
</div>
<script>
var VIZ = ${data};
var DB_ICON = ${JSON.stringify(DB_ICON_URI)};   // database glyph for the PG-table + IDB-store nodes
var REL_COLOR = {read:"#5eb0ef",write:"#54c98a",push:"#e0a44b",pull:"#b07ad6",domread:"#3fb6b6",domwrite:"#e06a9a",call:"#4a5169",handoff:"#5fb3a3"};
var nodeById = {}; VIZ.nodes.forEach(function(n){ nodeById[n.id]=n; });
var fnModule = {}; VIZ.nodes.forEach(function(n){ if(n.kind==="fn") fnModule[n.id]=n.module; });
// controller method → its class ("folder"). A controller class collapses/expands exactly like a TS
// module box: collapsed → one "cclass:<Class>" box; expanded → its method nodes shown inside it.
var ctrlClass = {}; VIZ.nodes.forEach(function(n){ if(n.kind==="controller") ctrlClass[n.id]=n.cls; });
var dataIds = {}; VIZ.nodes.forEach(function(n){ if(n.kind!=="fn") dataIds[n.id]=true; });
// total exported-fn count per top-level folder — for the collapsed folder-box labels.
var folderFnCount = {}; VIZ.modules.forEach(function(m){ var f=m.id.split("/")[0]; folderFnCount[f]=(folderFnCount[f]||0)+m.fnIds.length; });
var expanded = {};        // moduleId / "cclass:<Class>" → its functions/methods are shown
var folderExpanded = {};  // top-level folder name → its module boxes are shown (else the whole folder is one box)
// Two lenses over the SAME boxes. "flow" = data movement (read/write/push/pull/dom);
// "coupling" = which function calls which (the code's internal wiring / modularity).
// The toggle swaps which edge set is live AND what a click follows, so the two
// questions never muddy each other.
var mode = "flow";
var selId = null;        // currently traced node id (null = nothing selected)
var traceDir = "goes";   // "goes" (downstream/outputs) | "comesFrom" (upstream/inputs) | "both"
function applyMode(){
  var couple = mode==="coupling", imports = mode==="imports";
  // IMPORTS lens = module→module dependency edges (the cycle/TDZ view), nothing else.
  cy.edges('[rel = "import"]').style("display", imports?"element":"none");
  cy.edges('[rel = "call"]').style("display", (!imports && couple)?"element":"none");
  cy.edges('[rel != "call"][rel != "import"]').style("display", (!imports && !couple)?"element":"none");
  // FLOW lens also shows data-carrying call hops (calls on a path to a store/server) — the
  // genuine, hop-by-hop data path. Pure-control calls stay coupling-only.
  if(!imports && !couple) cy.edges('[rel = "call"][?dataPath]').style("display","element");
}

function rep(id){
  if(ctrlClass[id]!=null){ var box="cclass:"+ctrlClass[id]; return expanded[box]?id:box; }  // controller method → its class box when collapsed
  if(dataIds[id]) return id;
  var mod=fnModule[id]; if(mod==null) return id;
  var fld=mod.split("/")[0];
  if(!folderExpanded[fld]) return "fold:"+fld;          // whole folder collapsed → its one folder box
  return expanded[mod]?id:("mod:"+mod);
}

function rebuild(){
  // TWO axes, both meaningful:
  //   VERTICAL = role (from edges): PG tables / sync code / stores / capture code / DOM.
  //   HORIZONTAL = top-level source folder under resources/js (indexedDB, hyperlights,
  //   hypercites, divEditor). Each folder owns a contiguous zone; a box's column tells
  //   you its folder, its row tells you what it does → folder×role at a glance.
  var COLW=240, ROWH=44, MODH=34, STARTX=215;
  var TABLEY=70, GAP=90, TARGET_ROWS=8;
  var els=[];

  var byBand={capture:[],store:[],sync:[],components:[]};
  VIZ.modules.forEach(function(m){ (byBand[m.band]||byBand.store).push(m); });

  // folder zones across the X axis. Known folders in a fixed order, extras appended.
  var FOLDER_ORDER=["hyperlights","hypercites","divEditor","editToolbar","indexedDB","footnotes","citations","hyperlitContainer","lazyLoader","scrolling","pageLoad","SPA","components"];
  var FCOLOR={indexedDB:"#9aa6bd",hyperlights:"#3fb6b6",hypercites:"#caa14b",divEditor:"#5e8fd6",editToolbar:"#d18ad0",footnotes:"#c98a5e",citations:"#7bbf6a",hyperlitContainer:"#c45d6d",lazyLoader:"#6abf9f",scrolling:"#bf8a6a",pageLoad:"#8a7bbf",SPA:"#b06a8a",components:"#9c8f4e"};

  // The DATA-LAYER folders form the tall upper column grid. components/ modules are
  // pulled OUT of that grid into their own band directly above the DOM (they drive the
  // DOM most directly), sub-divided by their 2nd path segment (topRightContainer, etc).
  function dataFolderOf(m){ return m.id.split("/")[0]; }
  function compFolderOf(m){ return m.id.split("/")[1] || "components"; }

  var folders=[]; VIZ.modules.forEach(function(m){ if(m.band==="components") return; var f=dataFolderOf(m); if(folders.indexOf(f)<0) folders.push(f); });
  folders.sort(function(a,b){ var ia=FOLDER_ORDER.indexOf(a),ib=FOLDER_ORDER.indexOf(b); ia=ia<0?99:ia; ib=ib<0?99:ib; return ia-ib||(a<b?-1:1); });
  var compFolders=[]; byBand.components.forEach(function(m){ var f=compFolderOf(m); if(compFolders.indexOf(f)<0) compFolders.push(f); });
  compFolders.sort(function(a,b){return a<b?-1:(a>b?1:0);});

  // a folder gets >1 sub-column only when one band would otherwise stack too tall
  // baseKeyOf maps a column-folder to the top-level folder whose expand state governs it (identity for
  // the data grid; always "components" for the components band). A COLLAPSED folder shows as a single
  // box, so it only needs ONE column — that's what keeps the "min" view from staying grid-wide.
  function buildCols(folderList, bands, colKeyOf, baseKeyOf){
    var subCols={}, startCol={}, total=0;
    folderList.forEach(function(f){
      var maxIn=1;
      bands.forEach(function(b){ var c=byBand[b].filter(function(m){return colKeyOf(m)===f;}).length; if(c>maxIn)maxIn=c; });
      var base=baseKeyOf?baseKeyOf(f):f;
      subCols[f]= folderExpanded[base] ? Math.max(1,Math.ceil(maxIn/TARGET_ROWS)) : 1;
      startCol[f]=total; total+=subCols[f];
    });
    return {subCols:subCols,startCol:startCol,ncols:Math.max(1,total)};
  }
  var dataCols=buildCols(folders,["sync","store","capture"],dataFolderOf,function(f){return f;});
  // the components band's sub-folders all share the one "components" base — so when it's collapsed the
  // whole band is a SINGLE box and must claim a single column (else its many sub-folders keep inflating
  // the grid width and the "min" view never actually narrows).
  var compCols=folderExpanded["components"]
    ? buildCols(compFolders,["components"],compFolderOf,function(){return "components";})
    : {subCols:{},startCol:{},ncols:1};
  var NCOLS=Math.max(dataCols.ncols,compCols.ncols);
  // centre each band within the widest band's footprint (half the leftover columns)
  var dataOff=(NCOLS-dataCols.ncols)/2, compOff=(NCOLS-compCols.ncols)/2;

  // PURE-MIN = nothing drilled in: the whole code body is just one box per folder. Rather than spread
  // those ~15 boxes across the full grid (wide + short → tiny when fit), pack them into a narrow,
  // tall grid and squeeze the data-node rows to match — so fit zooms in and the labels read large.
  var pureMin = !Object.keys(folderExpanded).some(function(k){return folderExpanded[k];});
  var GCOLS=4, GPITCHX=300, GPITCHY=92;
  var minGridFolders = folders.slice(); if(compFolders.length) minGridFolders.push("components");
  // span [STARTX .. STARTX+fullW]: the grid's column span in pure-min, the full column grid otherwise.
  var fullW = pureMin ? (Math.min(GCOLS,minGridFolders.length)-1)*GPITCHX : STARTX+(NCOLS-1)*COLW;

  // place each band's modules into their folder's sub-column(s); cumulative Y per column.
  // colKeyOf → which column a module lands in; styleFolderOf → the folder used for colour;
  // xOff → columns to shift the band right so it's horizontally centred.
  function layoutBand(mods, topY, cols, folderList, colKeyOf, styleFolderOf, xOff){
    var colY=[]; for(var c=0;c<NCOLS;c++) colY[c]=topY;
    var byFolder={}; mods.forEach(function(m){ var f=colKeyOf(m); (byFolder[f]=byFolder[f]||[]).push(m); });
    folderList.forEach(function(f){
      var list=(byFolder[f]||[]).sort(function(a,c){return a.id<c.id?-1:(a.id>c.id?1:0);});
      list.forEach(function(m,i){
        if(!folderExpanded[m.id.split("/")[0]]) return;   // folder collapsed → its modules fold into one folder box (placed separately)
        var c=cols.startCol[f]+(i%cols.subCols[f]), colX=STARTX+(c+xOff)*COLW, sf=styleFolderOf(m);
        if(expanded[m.id]){
          els.push({data:{id:"mod:"+m.id,label:m.label,kind:"module",expanded:1,band:m.band,folder:sf}});
          var sy=colY[c]+30;
          m.fnIds.forEach(function(fid,j){ var n=nodeById[fid]; els.push({data:{id:fid,label:n.label,kind:"fn",parent:"mod:"+m.id,stage:n.stage,band:m.band,folder:sf,leaf:n.leaf?1:0},position:{x:colX,y:sy+j*ROWH}}); });
          colY[c]=sy+m.fnIds.length*ROWH+30;
        } else {
          els.push({data:{id:"mod:"+m.id,label:m.label+"  ("+m.fnIds.length+")",kind:"module",expanded:0,band:m.band,folder:sf},position:{x:colX,y:colY[c]}});
          colY[c]+=MODH+14;
        }
      });
    });
    return Math.max.apply(null,colY);
  }
  function compStyle(){ return "components"; }

  // Laravel controller tier — collapsible CLASS boxes between the PG tables and the routes, on TWO
  // rows: the whole-book AGGREGATORS up top (DatabaseToIndexedDB = the load aggregator, centred; the
  // save-side UnifiedSync/Beacon flank it), and the PER-DOMAIN write controllers below, ordered
  // left→right by domain (annotations | core content | bibliography) so they line up under the
  // matching PG tables. Row heights are dynamic (grow when a class is expanded), computed up front.
  var ctrlByClass={}; VIZ.nodes.forEach(function(n){ if(n.kind==="controller"){ (ctrlByClass[n.cls]=ctrlByClass[n.cls]||[]).push(n); } });
  // The two whole-book AGGREGATORS are the central spine, stacked dead-centre: the LOAD aggregator
  // (DatabaseToIndexedDB, PG→IDB) above the SAVE aggregator (UnifiedSync, IDB→PG — the reverse), with
  // Beacon (UnifiedSync's page-unload twin) beside it. Below them, the PER-DOMAIN writers, ordered
  // L→R by domain (annotations | core content | bibliography) to line up under the matching tables.
  var SPINE_LOAD="DatabaseToIndexedDBController", SPINE_SAVE="UnifiedSyncController", AGG_BEACON="BeaconSyncController";
  var CTRL_DOM_ORDER=["DbHyperlightController","DbHyperciteController","DbNodeChunkController","DbLibraryController","DbFootnoteController","DbReferencesController"]; // L: annotations · C: nodes+library · R: bibliography
  function domainArrange(keys, coreOrder){
    var core=coreOrder.filter(function(k){return keys.indexOf(k)>=0;});
    var extras=keys.filter(function(k){return coreOrder.indexOf(k)<0;}).sort();
    var L=[],R=[]; extras.forEach(function(e,i){ (i%2?R:L).push(e); });   // split extras to the edges so the core stays centred
    return L.concat(core).concat(R);
  }
  var aggAll=[SPINE_LOAD, SPINE_SAVE, AGG_BEACON];
  var domClasses=domainArrange(Object.keys(ctrlByClass).filter(function(c){return aggAll.indexOf(c)<0;}), CTRL_DOM_ORDER);
  function ctrlRowH(classes){ var anyExp=false,mx=1; classes.forEach(function(c){ if(ctrlByClass[c]&&expanded["cclass:"+c]){anyExp=true; if(ctrlByClass[c].length>mx)mx=ctrlByClass[c].length;} }); return anyExp?(22+mx*ROWH):MODH; }
  var AGG1_TOP=TABLEY+56, AGG1_H=ctrlRowH([SPINE_LOAD]);                 // load aggregator (centre)
  var AGG2_TOP=AGG1_TOP+AGG1_H+30, AGG2_H=ctrlRowH([SPINE_SAVE,AGG_BEACON]); // save aggregators (centre)
  var DOM_TOP=AGG2_TOP+AGG2_H+30, DOM_H=ctrlRowH(domClasses);            // per-domain writers
  var CTRL_BOTTOM=DOM_TOP+DOM_H;
  var ROUTE_PULL_Y=CTRL_BOTTOM+46;   // upper route row: data FROM backend (load) — arrows point DOWN
  var ROUTE_PUSH_Y=ROUTE_PULL_Y+58;  // lower route row: data TO backend (save) — arrows point UP
  var SYNC_TOP=ROUTE_PUSH_Y+GAP+10;  // sync code starts below the controller + API-route rows
  var STORECODE_TOP, STOREY, CAPTURE_TOP, capBottom, COMPONENTS_TOP, compBottom, DOMY, foldGrid=null;
  if(pureMin){
    // one tight grid of folder boxes stands in for ALL the code; stores/dom follow below it.
    var cxC=STARTX+fullW/2, gTop=SYNC_TOP+10;
    foldGrid={};
    minGridFolders.forEach(function(f,i){
      var row=Math.floor(i/GCOLS), inRow=Math.min(GCOLS, minGridFolders.length-row*GCOLS), j=i%GCOLS;
      foldGrid[f]={x:cxC+(j-(inRow-1)/2)*GPITCHX, y:gTop+row*GPITCHY};
    });
    var gRows=Math.ceil(minGridFolders.length/GCOLS);
    STORECODE_TOP=capBottom=COMPONENTS_TOP=compBottom=gTop+(gRows-1)*GPITCHY;
    STOREY=compBottom+GAP+30;
    DOMY=STOREY+GAP+40;
  } else {
    var syncBottom=layoutBand(byBand.sync, SYNC_TOP, dataCols, folders, dataFolderOf, dataFolderOf, dataOff);
    STORECODE_TOP=syncBottom+GAP;
    var storeBottom=layoutBand(byBand.store, STORECODE_TOP, dataCols, folders, dataFolderOf, dataFolderOf, dataOff);
    STOREY=storeBottom+GAP;                 // object-store barrels row (the IndexedDB level)
    CAPTURE_TOP=STOREY+GAP;
    capBottom=layoutBand(byBand.capture, CAPTURE_TOP, dataCols, folders, dataFolderOf, dataFolderOf, dataOff);
    COMPONENTS_TOP=capBottom+GAP;           // components band sits directly above the DOM
    compBottom=layoutBand(byBand.components, COMPONENTS_TOP, compCols, compFolders, compFolderOf, compStyle, compOff);
    DOMY=compBottom+GAP;
  }

  // Collapsed-folder boxes: one node standing in for an ENTIRE top-level folder. In pure-min they sit
  // in the compact grid above; in a mixed state (some folders drilled in) a collapsed folder keeps its
  // own column at the vertical middle of the data grid, so the grid — and a tracked selection — stays put.
  var foldMidY=(SYNC_TOP+capBottom)/2;
  folders.forEach(function(f){
    if(folderExpanded[f]) return;
    var pos = foldGrid ? foldGrid[f] : {x:STARTX+(dataOff+dataCols.startCol[f]+(dataCols.subCols[f]-1)/2)*COLW, y:foldMidY};
    els.push({data:{id:"fold:"+f,label:f+"  ("+(folderFnCount[f]||0)+")",kind:"folder",folder:f,hcolor:FCOLOR[f]||"#9aa6bd"},position:pos});
  });
  if(!folderExpanded["components"] && compFolders.length){
    var cpos = foldGrid ? foldGrid["components"] : {x:STARTX+(compOff+(compCols.ncols-1)/2)*COLW, y:(COMPONENTS_TOP+compBottom)/2};
    els.push({data:{id:"fold:components",label:"components  ("+(folderFnCount.components||0)+")",kind:"folder",folder:"components",hcolor:FCOLOR.components},position:cpos});
  }

  function spread(n,i){ return STARTX+(n<=1?fullW/2:(i*fullW)/(n-1)); }
  // pull the heaviest data node ("nodes") to the centre of its row so the map reads
  // symmetrically (matching the centred indexedDB folder column); the rest split
  // evenly to either side, keeping their existing relative order.
  function centreNodes(arr){
    var i=arr.findIndex(function(n){return n.label==="nodes";});
    if(i<0) return arr;
    var pin=arr[i], rest=arr.slice(0,i).concat(arr.slice(i+1)), mid=Math.floor(rest.length/2);
    return rest.slice(0,mid).concat([pin],rest.slice(mid));
  }
  var stores=centreNodes(VIZ.nodes.filter(function(n){return n.kind==="store";}));
  stores.forEach(function(n,i){ els.push({data:{id:n.id,label:n.label,kind:"store"},position:{x:spread(stores.length,i),y:STOREY}}); });
  // PG tables ordered by domain so they line up under the controllers that write them:
  // L: hyperlights/hypercites (annotations) · C: nodes/library (core) · R: footnotes/bibliography.
  var TABLE_DOM_ORDER=["hyperlights","hypercites","nodes","library","footnotes","bibliography"];
  var tableNodes=VIZ.nodes.filter(function(n){return n.kind==="table";});
  var tableOrder=domainArrange(tableNodes.map(function(n){return n.label;}), TABLE_DOM_ORDER);
  var tables=tableOrder.map(function(lbl){ return tableNodes.filter(function(n){return n.label===lbl;})[0]; }).filter(Boolean);
  tables.forEach(function(n,i){ els.push({data:{id:n.id,label:n.label,kind:"table"},position:{x:spread(tables.length,i),y:TABLEY}}); });
  // API endpoint tier — TWO rows by data-flow direction: PULL (from backend / load) on top pointing
  // DOWN, PUSH (to backend / save) below pointing UP. Within each row, ordered by domain
  // (content | sync | annotations) and centred (not spread full-width) so they cluster in the middle.
  var GROUP_ORDER={content:0,sync:1,annotations:2};
  var routeSort=function(a,b){ var ga=GROUP_ORDER[a.group]||0, gb=GROUP_ORDER[b.group]||0; return ga-gb||(a.label<b.label?-1:1); };
  var midW=fullW*0.5, midX0=STARTX+(fullW-midW)/2;
  function spreadMid(n,i){ return n<=1?STARTX+fullW/2:midX0+(i*midW)/(n-1); }
  var pullRoutes=VIZ.nodes.filter(function(n){return n.kind==="route"&&n.dir==="pull";}).slice().sort(routeSort);
  var pushRoutes=VIZ.nodes.filter(function(n){return n.kind==="route"&&n.dir==="push";}).slice().sort(routeSort);
  pullRoutes.forEach(function(n,i){ els.push({data:{id:n.id,label:n.label,kind:"route",group:n.group,dir:"pull"},position:{x:spreadMid(pullRoutes.length,i),y:ROUTE_PULL_Y}}); });
  pushRoutes.forEach(function(n,i){ els.push({data:{id:n.id,label:n.label,kind:"route",group:n.group,dir:"push"},position:{x:spreadMid(pushRoutes.length,i),y:ROUTE_PUSH_Y}}); });
  // Laravel controller tier — one collapsible box per controller CLASS (the "folder"). Collapsed:
  // a box "ControllerName (N)" whose method edges fold onto it (via rep). Expanded (double-click): a
  // compound box holding its method nodes — exactly like a TS module box drilling into its functions.
  // Two rows: aggregators (centred) above the per-domain writers (domain-ordered across the width).
  var ctrlW=fullW*0.96, ctrlX0=STARTX+(fullW-ctrlW)/2, cxCentre=STARTX+fullW/2;
  function spreadWide(n,i){ return n<=1?cxCentre:ctrlX0+(i*ctrlW)/(n-1); }
  function placeClassBox(c, cx, topY){
    if(!ctrlByClass[c]) return;
    var meths=ctrlByClass[c].slice().sort(routeSort), box="cclass:"+c, dir=meths[0].dir, grp=meths[0].group;
    if(expanded[box]){
      els.push({data:{id:box,label:c,kind:"cmodule",expanded:1,dir:dir,group:grp}});
      meths.forEach(function(m,j){ els.push({data:{id:m.id,label:m.label,kind:"controller",parent:box,dir:m.dir,group:m.group},position:{x:cx,y:topY+22+j*ROWH}}); });
    } else {
      els.push({data:{id:box,label:c+"  ("+meths.length+")",kind:"cmodule",expanded:0,dir:dir,group:grp},position:{x:cx,y:topY}});
    }
  }
  // central spine: load aggregator above save aggregator, both dead-centre; Beacon beside Save.
  placeClassBox(SPINE_LOAD, cxCentre, AGG1_TOP);
  placeClassBox(SPINE_SAVE, cxCentre, AGG2_TOP);
  placeClassBox(AGG_BEACON, cxCentre+COLW, AGG2_TOP);
  // per-domain writers — domain-ordered across the width
  domClasses.forEach(function(c,i){ placeClassBox(c, spreadWide(domClasses.length,i), DOM_TOP); });
  els.push({data:{id:"dom",label:"reader.blade.php",kind:"dom"},position:{x:fullW/2,y:DOMY}});

  // (folder column headers removed — folder identity is carried by node colour; the top-row labels
  // sat by the Postgres tables while the folders they named scattered far below, so they misled.)

  // left-margin labels: 3 big DATA levels + 2 role labels for the code GAPS
  var labelX = STARTX - 195;
  els.push({data:{id:"tier:postgres",label:"POSTGRESQL",kind:"tier"},position:{x:labelX,y:TABLEY}});
  els.push({data:{id:"tier:controllers",label:"LARAVEL\\n(controllers)",kind:"tier"},position:{x:labelX,y:AGG2_TOP}});
  els.push({data:{id:"tier:apipull",label:"API ▾ load\\n(from backend)",kind:"codeband"},position:{x:labelX,y:ROUTE_PULL_Y}});
  els.push({data:{id:"tier:apipush",label:"API ▴ save\\n(to backend)",kind:"codeband"},position:{x:labelX,y:ROUTE_PUSH_Y}});
  els.push({data:{id:"tier:idb",label:"INDEXEDDB\\n(object stores)",kind:"tier"},position:{x:labelX,y:STOREY}});
  els.push({data:{id:"tier:dom",label:"DOM\\n(reader.blade.php)",kind:"tier"},position:{x:labelX,y:DOMY}});
  if(pureMin){
    // no code bands in pure-min — the whole code body is the one folder grid
    els.push({data:{id:"band:grid",label:"code\\n(one box per folder)",kind:"codeband"},position:{x:labelX,y:(SYNC_TOP+STORECODE_TOP)/2}});
  } else {
    // role labels for the code GAPS between the data levels
    els.push({data:{id:"band:sync",label:"code:\\nIndexedDB ↔ server",kind:"codeband"},position:{x:labelX,y:(SYNC_TOP+syncBottom)/2}});
    els.push({data:{id:"band:capture",label:"code:\\npage ↔ IndexedDB",kind:"codeband"},position:{x:labelX,y:(CAPTURE_TOP+capBottom)/2}});
    els.push({data:{id:"band:components",label:"code:\\nDOM components",kind:"codeband"},position:{x:labelX,y:(COMPONENTS_TOP+compBottom)/2}});
  }

  // folder of an endpoint id ("mod:hyperlights/x" / "hyperlights/x:fn" → "hyperlights")
  function folderOf(id){ id=id.replace(/^mod:|^fold:/,""); return id.split("/")[0]; }
  var seen={};
  VIZ.edges.forEach(function(e){
    var s=rep(e.source), t=rep(e.target);
    if(!s||!t||s===t) return;
    var k=s+"|"+t+"|"+e.rel;
    if(seen[k]) return; seen[k]=true;
    // a call edge that crosses folders = coupling between modules (the modularity smell)
    var cross=(e.rel==="call" && folderOf(s)!==folderOf(t))?1:0;
    els.push({data:{id:k,source:s,target:t,rel:e.rel,cross:cross,dataPath:e.dataPath?1:0,label:e.label||""}});
  });
  // module→module IMPORT edges (the cycle/TDZ lens) — between module boxes, but a module whose folder
  // is collapsed shows as its folder box, so fold the endpoint onto "fold:<folder>" to keep both ends real.
  function repMod(modId){ var fld=modId.split("/")[0]; return folderExpanded[fld]?("mod:"+modId):("fold:"+fld); }
  (VIZ.importEdges||[]).forEach(function(e){
    var s=repMod(e.source), t=repMod(e.target);
    if(s===t) return;
    var k=s+"|"+t+"|import";
    if(seen[k]) return; seen[k]=true;
    els.push({data:{id:k,source:s,target:t,rel:"import",kind:e.kind,label:""}});
  });
  cy.json({elements:els});
  cy.style().update();
  applyMode();
  cy.layout({name:"preset"}).run();
}

var cy = cytoscape({
  container: document.getElementById("cy"),
  elements: [],
  autoungrabify: true,        // nodes are NOT draggable (don't move when you pan/scroll)
  wheelSensitivity: 0.2,
  style: [
    {selector:"node",style:{"label":"data(label)","color":"#e6e9ef","font-size":"11px","text-valign":"center","text-halign":"center","width":"label","height":"24px","padding":"7px","shape":"roundrectangle","background-color":"#1e2230","border-width":1,"border-color":"#3a4150","text-wrap":"none"}},
    {selector:"node[kind = 'module']",style:{"background-color":"#283246","border-color":"#4a5777","font-weight":"bold","padding":"9px"}},
    {selector:"node[kind = 'module'][?expanded]",style:{"background-opacity":0.12,"border-style":"dashed","border-color":"#5a6c8a","text-valign":"top","text-margin-y":-2,"font-weight":"bold","color":"#9fb0d6","shape":"roundrectangle"}},
    {selector:"node[kind = 'fn']",style:{"background-color":"#222b3a","border-color":"#3a4660"}},
    {selector:"node[kind = 'fn'][?leaf]",style:{"opacity":0.6}},
    {selector:"node[kind = 'store']",style:{"background-color":"#1f4a3c","border-color":"#54c98a","shape":"barrel","padding":"10px","font-weight":"bold"}},
    {selector:"node[kind = 'table']",style:{"background-color":"#3d2350","border-color":"#b07ad6","shape":"round-rectangle","padding":"11px","font-weight":"bold"}},
    // database glyph + name, CENTRED AS A GROUP with even side margins. The label is nudged right by
    // half the icon's footprint (text-margin-x) and the icon placed just to its left; with
    // posX = padding - margin the left margin (=posX) and right margin (=padding - margin) are equal,
    // so [icon · gap · name] sits centred. padding raised to 24 so the side margins (=15) match the
    // generous top/bottom feel. (icon 12, gap 6 → margin 9, posX = 24-9 = 15.)
    {selector:"node[kind = 'table'], node[kind = 'store']",style:{"background-image":DB_ICON,"background-fit":"none","background-width":"12px","background-height":"12px","background-position-x":"15px","background-position-y":"50%","background-clip":"none","padding":"24px","text-margin-x":"9px"}},
    // web-storage barrels — same DB glyph + store row, distinct amber/orange (vs green IndexedDB)
    {selector:"node[id = 'store:localStorage']",style:{"background-color":"#4a3a1f","border-color":"#e0a44b"}},
    {selector:"node[id = 'store:sessionStorage']",style:{"background-color":"#4a2c1f","border-color":"#e0795b"}},
    {selector:"node[kind = 'route']",style:{"background-color":"#161d2b","border-color":"#5a6c8a","shape":"round-rectangle","padding":"9px","font-size":"10px","font-weight":"bold"}},
    // square-ish body so the label stays readable, with a triangular point on one edge marking direction:
    // pull = body on top, point DOWN (data coming FROM backend); push = point UP, body below (data going TO backend).
    {selector:"node[kind = 'route'][dir = 'pull']",style:{"shape":"polygon","shape-polygon-points":"-1 -1  1 -1  1 0.45  0 1  -1 0.45","padding":"11px","text-margin-y":"-3px"}},
    {selector:"node[kind = 'route'][dir = 'push']",style:{"shape":"polygon","shape-polygon-points":"0 -1  1 -0.45  1 1  -1 1  -1 -0.45","padding":"11px","text-margin-y":"3px"}},
    {selector:"node[kind = 'route'][group = 'content']",style:{"border-color":"#54c98a","color":"#cfeae0"}},
    {selector:"node[kind = 'route'][group = 'annotations']",style:{"border-color":"#b07ad6","color":"#e8d6f5"}},
    {selector:"node[kind = 'route'][group = 'sync']",style:{"border-color":"#e0a44b","color":"#f0e2c2"}},
    // Laravel controller CLASS box (the collapsible "folder") + its method tags inside.
    {selector:"node[kind = 'cmodule']",style:{"background-color":"#2a1620","border-color":"#c45d6d","color":"#f0d6dd","shape":"round-rectangle","padding":"9px","font-size":"11px","font-weight":"bold","text-wrap":"wrap","text-max-width":"150px"}},
    {selector:"node[kind = 'cmodule'][?expanded]",style:{"background-opacity":0.12,"border-style":"dashed","text-valign":"top","text-margin-y":-2}},
    {selector:"node[kind = 'cmodule'][group = 'annotations']",style:{"border-color":"#b07ad6"}},
    {selector:"node[kind = 'cmodule'][group = 'sync']",style:{"border-color":"#e0a44b"}},
    // Laravel controllers — a distinct dark-red tag (PHP tier), domain coloured on the border like routes.
    {selector:"node[kind = 'controller']",style:{"background-color":"#2a1620","border-color":"#c45d6d","color":"#f0d6dd","shape":"tag","padding":"7px","font-size":"9px","font-weight":"bold"}},
    {selector:"node[kind = 'controller'][group = 'content']",style:{"border-color":"#54c98a"}},
    {selector:"node[kind = 'controller'][group = 'annotations']",style:{"border-color":"#b07ad6"}},
    {selector:"node[kind = 'controller'][group = 'sync']",style:{"border-color":"#e0a44b"}},
    {selector:"node[kind = 'dom']",style:{"background-color":"#2a3a5c","border-color":"#6f8bd6","shape":"ellipse","padding":"14px","font-weight":"bold"}},
    {selector:"node[folder = 'hyperlights']",style:{"background-color":"#143a40","border-color":"#3fb6b6","color":"#cfeaea"}},
    {selector:"node[folder = 'hypercites']",style:{"background-color":"#3a3320","border-color":"#caa14b","color":"#f0e2c2"}},
    {selector:"node[folder = 'divEditor']",style:{"background-color":"#16294a","border-color":"#5e8fd6","color":"#d4e2f5"}},
    {selector:"node[folder = 'indexedDB']",style:{"background-color":"#222b3a","border-color":"#4a5670","color":"#c8d0e0"}},
    {selector:"node[kind = 'tier']",style:{"label":"data(label)","color":"#5a6788","font-size":"28px","font-weight":"bold","background-opacity":0,"border-width":0,"text-halign":"center","text-valign":"center","text-wrap":"wrap","width":"label","height":"label","events":"no"}},
    {selector:"node[kind = 'codeband']",style:{"label":"data(label)","color":"#566688","font-size":"13px","font-weight":"bold","background-opacity":0,"border-width":0,"text-halign":"center","text-valign":"center","text-wrap":"wrap","width":"label","height":"label","events":"no"}},
    {selector:"node[kind = 'colheader']",style:{"label":"data(label)","color":"data(hcolor)","font-size":"20px","font-weight":"bold","background-opacity":0,"border-width":0,"text-halign":"center","text-valign":"center","width":"label","height":"label","events":"no"}},
    // collapsed whole-folder box — bigger/bolder than a module box, outlined in its folder colour
    {selector:"node[kind = 'folder']",style:{"background-color":"#283246","border-color":"data(hcolor)","color":"data(hcolor)","border-width":3,"font-weight":"bold","font-size":"18px","shape":"roundrectangle","padding":"20px"}},
    {selector:"edge",style:{"width":1.4,"curve-style":"bezier","target-arrow-shape":"triangle","arrow-scale":0.8,"line-color":"#4a5169","target-arrow-color":"#4a5169","opacity":0.75}},
    {selector:"edge[rel = 'read']",style:{"line-color":REL_COLOR.read,"target-arrow-color":REL_COLOR.read}},
    {selector:"edge[rel = 'write']",style:{"line-color":REL_COLOR.write,"target-arrow-color":REL_COLOR.write}},
    {selector:"edge[rel = 'push']",style:{"line-color":REL_COLOR.push,"target-arrow-color":REL_COLOR.push,"width":2.2}},
    {selector:"edge[rel = 'pull']",style:{"line-color":REL_COLOR.pull,"target-arrow-color":REL_COLOR.pull,"width":2.2}},
    {selector:"edge[rel = 'domread']",style:{"line-color":REL_COLOR.domread,"target-arrow-color":REL_COLOR.domread}},
    {selector:"edge[rel = 'domwrite']",style:{"line-color":REL_COLOR.domwrite,"target-arrow-color":REL_COLOR.domwrite}},
    {selector:"edge[rel = 'call']",style:{"line-color":REL_COLOR.call,"target-arrow-color":REL_COLOR.call,"line-style":"dashed","opacity":0.4,"arrow-scale":0.6}},
    {selector:"edge[rel = 'call'][?cross]",style:{"line-color":"#e0683c","target-arrow-color":"#e0683c","opacity":0.85,"width":2}},
    {selector:"edge[rel = 'call'][?dataPath]",style:{"line-style":"solid","line-color":REL_COLOR.handoff,"target-arrow-color":REL_COLOR.handoff,"opacity":0.9,"width":2}},
    {selector:"edge[rel = 'import']",style:{"width":1.4,"curve-style":"bezier","target-arrow-shape":"triangle","arrow-scale":0.7,"line-color":"#5a6480","target-arrow-color":"#5a6480","line-style":"solid","opacity":0.45}},
    {selector:"edge[rel = 'import'][kind = 'breaker']",style:{"line-color":"#e0a44b","target-arrow-color":"#e0a44b","line-style":"dashed","opacity":0.8,"width":1.8}},
    {selector:"edge[rel = 'import'][kind = 'lazy']",style:{"line-color":"#5fb3a3","target-arrow-color":"#5fb3a3","line-style":"dashed","opacity":0.7}},
    // highlight classes LAST so they win over the base import/call edge colours (cytoscape = last match wins)
    {selector:"node.faded",style:{"opacity":0.28}},
    {selector:"edge.faded",style:{"opacity":0.05}},
    {selector:"node.hl",style:{"border-width":2.5,"border-color":"#fff","opacity":1}},
    {selector:"edge.hl",style:{"opacity":1,"width":2.6}},
    {selector:"node.ring",style:{"border-width":3.5,"border-color":"#ff5a5c","background-color":"#3a1c20","opacity":1}},
    {selector:"node.latentring",style:{"border-width":3.5,"border-color":"#f0b65e","background-color":"#3a2e18","opacity":1}},
    {selector:"edge.latent",style:{"line-color":"#f0b65e","target-arrow-color":"#f0b65e","opacity":1,"width":3,"z-index":90}},
    {selector:"edge.cycle",style:{"line-color":"#ff5a5c","target-arrow-color":"#ff5a5c","line-style":"solid","opacity":1,"width":3.4,"z-index":99}}
  ],
  layout:{name:"preset"}
});

function relabel(id){ return id.replace(/^store:|^pg:|^mod:|^route:|^controller:/,""); }
function clearHL(){ cy.elements().removeClass("faded hl cycle ring"); }

// Edges that belong to the active lens: data-flow edges in "flow", fn-call edges in "coupling".
function lensEdgeSel(){ return mode==="coupling" ? 'edge[rel = "call"]' : 'edge[rel != "call"], edge[rel = "call"][?dataPath]'; }
// adjacency (out / incoming) over the current lens's edges, respecting collapse state
function buildAdj(){
  var out={}, inc={};
  cy.edges(lensEdgeSel()).forEach(function(e){
    var s=e.source().id(), t=e.target().id();
    (out[s]=out[s]||[]).push(t); (inc[t]=inc[t]||[]).push(s);
  });
  return {out:out, inc:inc};
}
function reachSet(start, adj){ var seen={}; var q=[start]; while(q.length){ var c=q.shift(); (adj[c]||[]).forEach(function(nx){ if(!seen[nx]){ seen[nx]=1; q.push(nx); } }); } return seen; }

function isDataNode(id){ return id==="dom" || id.indexOf("store:")===0 || id.indexOf("pg:")===0; }
// FLOW trace: follow data DOWNSTREAM (the way the arrows point) from the clicked node, and STOP
// at any store/table/DOM — data that lands there has arrived; nothing past it is a continuation
// of this same hand-off. Bounded "where does this code's data end up". (Precise per-OBJECT
// tracing through shared functions needs the type layer — that's Stage 2.)
// Directed reach over the flow edges from a set of start nodes. useOut = follow arrows forward
// (downstream / where data goes); useIn = backward (upstream / where it comes from). When
// stopAtData, terminate AT a store/table/DOM (data has landed) — but never at the START node,
// so selecting a store itself still shows what reads/writes it.
function flowReach(startIds, useOut, useIn, stopAtData){
  var out={}, inc={};
  cy.edges('edge[rel != "call"], edge[rel = "call"][?dataPath]').forEach(function(e){
    var s=e.source().id(), t=e.target().id();
    (out[s]=out[s]||[]).push({n:t,e:e}); (inc[t]=inc[t]||[]).push({n:s,e:e});
  });
  var startSet={}; startIds.forEach(function(s){startSet[s]=1;});
  var nodes={}, edges={}, q=[];
  startIds.forEach(function(s){ if(!nodes[s]){nodes[s]=1;q.push(s);} });
  while(q.length){
    var cur=q.shift();
    if(stopAtData && !startSet[cur] && isDataNode(cur)) continue;
    if(useOut) (out[cur]||[]).forEach(function(x){ edges[x.e.id()]=1; if(!nodes[x.n]){nodes[x.n]=1;q.push(x.n);} });
    if(useIn) (inc[cur]||[]).forEach(function(x){ edges[x.e.id()]=1; if(!nodes[x.n]){nodes[x.n]=1;q.push(x.n);} });
  }
  return {nodes:nodes, edges:edges};
}
function paintTrace(r){
  Object.keys(r.nodes).forEach(function(k){ var el=cy.getElementById(k); if(el&&el.length) el.removeClass("faded").addClass("hl"); });
  Object.keys(r.edges).forEach(function(k){ var el=cy.getElementById(k); if(el&&el.length) el.removeClass("faded").addClass("hl"); });
}
// Re-apply the current selection + direction. FLOW lens honours traceDir (goes/comesFrom/both);
// COUPLING lens always shows full transitive reach + red feedback-loop cycles.
function applyTrace(){
  if(mode==="imports") return;   // imports lens isn't a data/coupling trace — click just shows detail
  // A typed Postgres table → trace its data TYPE through the real code. With the direction toggle on
  // "both" (the default) this is the whole PG↔IDB↔DOM lineage; "goes"/"comesFrom" narrow it to the
  // load (table → … → DOM) or save (DOM → … → table) half, following the actual flow edges.
  var sel = selId ? nodeById[selId] : null;
  if(sel && sel.kind==="table" && sel.types && sel.types.length){
    if(traceDir==="both") paintTypeTrace(selId);
    else paintTypeTraceDir(selId, traceDir);
    return;
  }
  // a collapsed function shows as its module/folder box — trace from whatever box represents it.
  var start = selId ? rep(selId) : null;
  cy.elements().addClass("faded").removeClass("hl cycle");
  if(mode==="coupling"){
    if(!start){ clearHL(); return; }
    var adj=buildAdj();
    var down=reachSet(start, adj.out), up=reachSet(start, adj.inc);
    var inTrace={}; inTrace[start]=1;
    Object.keys(down).forEach(function(k){inTrace[k]=1;}); Object.keys(up).forEach(function(k){inTrace[k]=1;});
    var cyc={}; cyc[start]=1; Object.keys(down).forEach(function(k){ if(up[k]) cyc[k]=1; });
    Object.keys(inTrace).forEach(function(k){ var el=cy.getElementById(k); if(el&&el.length) el.removeClass("faded").addClass("hl"); });
    cy.edges(lensEdgeSel()).forEach(function(e){ var s=e.source().id(), t=e.target().id(); if(inTrace[s]&&inTrace[t]){ e.removeClass("faded").addClass("hl"); if(cyc[s]&&cyc[t]) e.addClass("cycle"); } });
    return;
  }
  var useOut = traceDir!=="comesFrom", useIn = traceDir!=="goes";
  if(start){
    paintTrace(flowReach([start], useOut, useIn, true));         // node: stop where data lands
  } else {
    // nothing selected → the macro pipeline(s), full chain (no stop)
    var dom=["dom"], pg=cy.nodes('[kind = "table"]').map(function(x){return x.id();});
    if(traceDir==="goes") paintTrace(flowReach(dom, true, false, false));          // SAVE: DOM → … → Postgres
    else if(traceDir==="comesFrom") paintTrace(flowReach(pg, true, false, false));  // LOAD: Postgres → … → DOM
    else { var a=flowReach(dom,true,false,false), b=flowReach(pg,true,false,false);
      paintTrace({nodes:Object.assign({},a.nodes,b.nodes), edges:Object.assign({},a.edges,b.edges)}); }
  }
}
function highlight(n){ selId=n.id(); applyTrace(); }
// After a relayout (level change / drill), keep whatever was selected lit + described. The selected
// id may now be hidden inside a collapsed box, so re-light via the trace (which traces from its
// representative box) and re-describe the displayed box.
function reselect(){
  if(!selId){ clearHL(); applyMode(); return; }
  applyTrace();
  var disp=cy.getElementById(rep(selId)); if(disp&&disp.length) showDetail(disp);
}
// Reframe after a level change / drill: zoom to the lit trace if something's selected (keeps the
// tracked node framed at the new, tighter zoom), otherwise to the whole — narrower min layout → fits
// bigger, which is the point of folder-collapsing.
function fitView(){
  var lit=cy.elements(".hl");
  cy.animate({fit:{eles:(selId&&lit.length)?lit:cy.elements(),padding:50}},{duration:300});
}

// TYPE TRACE: clicking a Postgres table that carries a type lineage lights the functions whose
// signature/body actually REFERENCE those types (the real data handlers, from the TS annotations
// collect.ts read), plus every real call/data edge between them — forced visible past the lens, so
// the call hops show too. The grid's rows order it PG(top) -> DOM(bottom): you watch the record
// move through the actual code. Fixes the old empty table-trace (a sink had no edges to follow).
function carryingForTable(tableId){
  var tn=nodeById[tableId]; if(!tn||!tn.types||!tn.types.length) return null;
  var want={}; tn.types.forEach(function(t){want[t]=1;});
  var carry={}; carry[tableId]=1;
  VIZ.nodes.forEach(function(n){ if(n.kind==="fn"&&n.types){ for(var i=0;i<n.types.length;i++){ if(want[n.types[i]]){ carry[n.id]=1; break; } } } });
  // + walk the push/pull SEAM out from this table to the load/save functions, through the API
  // route AND Laravel controller hops (PG ← controller ← route ← fn). A bounded BFS over push/pull
  // edges lights every node on the way, but never crosses INTO a sibling table — so a multi-table
  // controller (e.g. the node upsert also touches library for its auth check) lights as a carrier
  // without dragging the unrelated tables into the trace.
  var seam={}; seam[tableId]=1; var queue=[tableId];
  while(queue.length){
    var cur=queue.shift();
    VIZ.edges.forEach(function(e){
      if(e.rel!=="push"&&e.rel!=="pull") return;
      var nb = e.source===cur?e.target : (e.target===cur?e.source:null);
      if(!nb||seam[nb]) return;
      var nn=nodeById[nb];
      if(nn&&nn.kind==="table"&&nb!==tableId) return;   // don't bleed into sibling tables
      seam[nb]=1; queue.push(nb);
    });
  }
  Object.keys(seam).forEach(function(id){ carry[id]=1; });
  return carry;
}
// The DISPLAYED type-carrier set: the carriers (collapsed fns mapped to their box) + the data
// WAYPOINTS the data physically passes through (its IndexedDB store + the DOM), so the trace shows
// the record landing in the store and reaching the page, not just the functions. For non-content
// tables (no store of their own) it also adds the web-storage a BASE carrier writes (the typed data's
// real home) — never the seam-expanded set, which can poke unrelated web-storage for UI state.
function typeTraceDisp(tableId){
  var carry=carryingForTable(tableId); if(!carry) return null;
  var disp={}; Object.keys(carry).forEach(function(id){ disp[rep(id)]=1; });
  var name=tableId.indexOf("pg:")===0?tableId.slice(3):tableId;
  ["store:"+name, "dom"].forEach(function(w){ if(nodeById[w]) disp[w]=1; });
  var tabTypes=(nodeById[tableId]&&nodeById[tableId].types)||[];
  if(!nodeById["store:"+name] && tabTypes.length){
    var tset={}; tabTypes.forEach(function(t){ tset[t]=1; });
    VIZ.edges.forEach(function(e){
      if(e.rel!=="write") return;
      var st=e.target;
      if(st!=="store:localStorage" && st!=="store:sessionStorage") return;
      var fn=nodeById[e.source];
      if(fn && fn.types && fn.types.some(function(t){ return tset[t]; })) disp[rep(st)]=1;
    });
  }
  return disp;
}
// "both" — the full lineage: light the whole carrier set + every edge between two members.
function paintTypeTrace(tableId){
  var disp=typeTraceDisp(tableId); if(!disp) return false;
  cy.elements().addClass("faded").removeClass("hl cycle ring latentring");
  Object.keys(disp).forEach(function(k){ var el=cy.getElementById(k); if(el&&el.length) el.removeClass("faded").addClass("hl"); });
  cy.edges().forEach(function(e){ var s=e.source().id(), t=e.target().id(); if(disp[s]&&disp[t]){ e.style("display","element"); e.removeClass("faded").addClass("hl"); } });
  return true;
}
// "goes"/"comesFrom" — the SAME typed carrier set, but only the edges that MOVE that direction. A
// directional BFS is useless here: the IndexedDB store is a hub with both in- and out-edges, so a walk
// reaches everything either way and "goes" == "comesFrom" == "both". So light by edge CLASS instead:
//   goes (load, PG→page):    pull (PG→fn) · read (store→fn) · domwrite (fn→DOM)
//   comesFrom (save, page→PG): push (fn→PG) · domread (DOM→fn) · write (fn→store)
// (read↔write split the shared store between the two halves so each direction lights a distinct seam.)
function paintTypeTraceDir(tableId, dir){
  var disp=typeTraceDisp(tableId); if(!disp) return false;
  var LOAD={pull:1,read:1,domwrite:1}, SAVE={push:1,domread:1,write:1};
  var want = dir==="goes" ? LOAD : SAVE;
  cy.elements().addClass("faded").removeClass("hl cycle ring latentring");
  var lit={}; lit[tableId]=1;
  cy.edges().forEach(function(e){
    if(!want[e.data("rel")]) return;
    var s=e.source().id(), t=e.target().id();
    if(!disp[s]||!disp[t]) return;
    e.style("display","element"); e.removeClass("faded").addClass("hl");
    lit[s]=1; lit[t]=1;
  });
  Object.keys(lit).forEach(function(k){ var el=cy.getElementById(k); if(el&&el.length) el.removeClass("faded").addClass("hl"); });
  return true;
}

function groupsFor(ids){
  var set={}; ids.forEach(function(i){set[i]=true;});
  var g={read:[],write:[],push:[],pull:[],dom:[],call:[]};
  VIZ.edges.forEach(function(e){
    if(set[e.source]){
      if(e.rel==="write")g.write.push(relabel(e.target));
      if(e.rel==="push")g.push.push("↑ "+relabel(e.target)+(e.label?"  ("+e.label+")":""));
      if(e.rel==="domwrite")g.dom.push("writes DOM");
      if(e.rel==="call" && !set[e.target])g.call.push(relabel(e.target));
    }
    if(set[e.target]){
      if(e.rel==="read")g.read.push(relabel(e.source));
      if(e.rel==="pull")g.pull.push("↓ "+relabel(e.source)+(e.label?"  ("+e.label+")":""));
      if(e.rel==="domread")g.dom.push("reads DOM");
    }
  });
  return g;
}
function ul(a){ if(!a.length) return "<p class='none'>none</p>"; var u=a.filter(function(v,i,s){return s.indexOf(v)===i;}).sort(); return "<ul>"+u.map(function(x){return "<li>"+x+"</li>";}).join("")+"</ul>"; }

var DIRTXT={goes:"where it goes \\u25B8",comesFrom:"\\u25C2 where it comes from",both:"both ways"};
function showDetail(n){
  var d=document.getElementById("detail"); var id=n.id(); var kind=n.data("kind");
  var dirBadge = mode==="flow" ? "<div class='dirbadge'>tracing: "+DIRTXT[traceDir]+"</div>" : "";
  if(kind==="store"||kind==="table"||kind==="dom"){
    var movers=[]; VIZ.edges.forEach(function(e){ if(e.source===id) movers.push(relabel(e.target)+"  ("+e.rel+")"); if(e.target===id) movers.push(relabel(e.source)+"  ("+e.rel+")"); });
    var schemaHtml="";
    if(kind==="store"){ var sc=VIZ.storeSchema[n.data("label")]; if(sc){ schemaHtml="<h3>key</h3><ul><li>"+sc.keyPath+"</li></ul><h3>indexes</h3>"+ul(sc.indices); } }
    // Table with a TS type lineage: show the types being traced + the functions that handle them
    // (the lit set), so the panel names what's flowing through the highlighted path on the map.
    var typeHtml="";
    if(kind==="table" && nodeById[id] && nodeById[id].types && nodeById[id].types.length){
      var tt=nodeById[id].types, carry=carryingForTable(id);
      var fnList=VIZ.nodes.filter(function(x){return x.kind==="fn"&&carry[x.id]&&x.types&&x.types.length;}).map(function(x){return x.label+"  ("+x.types.join(", ")+")";}).sort();
      typeHtml="<h3>data types (TS lineage)</h3>"+ul(tt)+
        "<p class='none' style='font-style:normal'>The PG↔IDB↔DOM journey of this data, from its TS types. The <b>trace:</b> button narrows it — <i>where it goes</i> = load (table→DOM), <i>where it comes from</i> = save (DOM→table), <i>both</i> = the full lineage.</p>"+
        "<h3>flows through "+fnList.length+" fns — lit on the map (rows = PG→DOM)</h3>"+ul(fnList);
    }
    var storeSub=n.data("label")==="localStorage"?"Browser localStorage — persistent key→value (NOT IndexedDB)":n.data("label")==="sessionStorage"?"Browser sessionStorage — per-tab key→value (NOT IndexedDB)":"IndexedDB object store";
    d.innerHTML="<div class='name'>"+n.data("label")+"</div><div class='sub'>"+(kind==="store"?storeSub:kind==="table"?"PostgreSQL table":"the reader page — every DOM-manipulation module reads/writes it")+"</div>"+dirBadge+schemaHtml+typeHtml+"<h3>connected functions</h3>"+ul(movers);
    return;
  }
  var ids, title, sub;
  if(kind==="folder"){ var fld=n.data("folder"); ids=VIZ.nodes.filter(function(x){return x.kind==="fn"&&x.module&&x.module.split("/")[0]===fld;}).map(function(x){return x.id;}); title=fld; sub=ids.length+" functions across the "+fld+" folder — double-click to drill in"; }
  else if(kind==="module"){ var mid=id.slice(4); var mod=VIZ.modules.filter(function(m){return m.id===mid;})[0]; ids=mod?mod.fnIds:[]; title=mid; sub=(mod?mod.stage:"")+" · "+ids.length+" functions"; }
  else if(kind==="cmodule"){ var ccls=id.slice(7); var meths=VIZ.nodes.filter(function(m){return m.kind==="controller"&&m.cls===ccls;}); ids=meths.map(function(m){return m.id;}); title=ccls; sub="app/Http/Controllers/"+ccls+".php · "+ids.length+" route method(s) — double-click to "+(n.data("expanded")?"collapse":"expand"); }
  else { ids=[id]; title=n.data("label"); sub=(n.data("stage")||"")+" · "+id.split(":")[0]; }
  var g=groupsFor(ids);
  d.innerHTML="<div class='name'>"+title+"</div><div class='sub'>"+sub+"</div>"+dirBadge+
    "<h3>reads (store → fn)</h3>"+ul(g.read)+
    "<h3>writes (fn → store)</h3>"+ul(g.write)+
    "<h3>DOM</h3>"+ul(g.dom)+
    "<h3>postgres (via PHP)</h3>"+ul(g.push.concat(g.pull))+
    ((kind==="module"||kind==="cmodule"||kind==="folder")?"":"<h3>calls</h3>"+ul(g.call));
}

// ONE consistent rule: single click = trace data flow + detail (anything, modules too).
// Double click a FOLDER box = drill into its modules; a MODULE box = drill into its files; a
// controller CLASS = its methods (the only things that re-lay-out). Re-collapse a whole folder
// via the detail dropdown (min). The current selection stays lit across the relayout.
var lastTap={id:null,t:0};
cy.on("tap","node",function(ev){
  var n=ev.target, id=n.id(), kind=n.data("kind");
  if(kind==="tier" || kind==="codeband" || kind==="colheader") return;
  var now=Date.now(), isDouble=(lastTap.id===id && now-lastTap.t<350); lastTap={id:id,t:now};
  if(isDouble && (kind==="folder" || kind==="module" || kind==="cmodule")){
    if(kind==="folder"){ var fld=n.data("folder"); if(folderExpanded[fld]) delete folderExpanded[fld]; else folderExpanded[fld]=true; }
    else {
      // module box keyed by its path ("mod:<path>" → <path>); controller-class box keyed by its full id.
      var key = kind==="module" ? id.slice(4) : id;
      if(expanded[key]) delete expanded[key]; else expanded[key]=true;
    }
    rebuild(); reselect();
    if(!selId){ var box=cy.getElementById(id); if(box&&box.length) showDetail(box); }
    return;
  }
  // highlight() → applyTrace(), which routes a typed table to the type trace (the data-type
  // lineage) and everything else to the normal flow/coupling trace. One path, no clobbering.
  highlight(n); showDetail(n);
});
cy.on("tap",function(ev){ if(ev.target===cy || (ev.target.isEdge && ev.target.isEdge())){ selId=null; clearHL(); applyMode(); } });

document.getElementById("meta").textContent=VIZ.meta.dbName+" v"+VIZ.meta.dbVersion+" · "+VIZ.meta.fnCount+" fns / "+VIZ.meta.moduleCount+" modules · "+VIZ.meta.storeCount+" stores · "+VIZ.meta.tableCount+" tables";
var leg=document.getElementById("legend"); VIZ.legend.forEach(function(l){ var row=document.createElement("div"); row.innerHTML="<span class='sw' style='border-top-color:"+REL_COLOR[l.rel]+"'></span><b>"+l.rel+"</b> &nbsp;"+l.from+"→"+l.to; leg.appendChild(row); });
// "trace data type" picker — lists the typed Postgres tables and runs the SAME type trace a click on
// that table runs (for anyone who doesn't realise the tables are clickable, or doesn't want to hunt
// for one on the map). Driving selId + applyTrace reuses the exact click path.
var sel=document.getElementById("focus"); var o0=document.createElement("option"); o0.value=""; o0.textContent="(pick a table)"; sel.appendChild(o0);
VIZ.nodes.filter(function(n){return n.kind==="table"&&n.types&&n.types.length;}).forEach(function(n){ var o=document.createElement("option"); o.value=n.id; o.textContent=n.label; sel.appendChild(o); });
sel.onchange=function(){
  if(!sel.value){ selId=null; clearHL(); applyMode(); return; }
  var n=cy.getElementById(sel.value); if(!n||!n.length) return;
  selId=sel.value; applyTrace(); showDetail(n);
  var lit=cy.elements(".hl"); cy.animate({fit:{eles:lit.length?lit:n,padding:60}},{duration:300});
};
// detail-level dropdown — min: one box per top-level folder · default: one box per module · max:
// every function. Keeps the current selection lit across the relayout (reselect, not clearHL).
document.getElementById("zoomLevel").onchange=function(){
  var v=this.value;
  if(v==="max"){ folderExpanded={}; expanded={}; VIZ.modules.forEach(function(m){ folderExpanded[m.id.split("/")[0]]=true; expanded[m.id]=true; }); VIZ.nodes.forEach(function(n){ if(n.kind==="controller") expanded["cclass:"+n.cls]=true; }); }
  else if(v==="default"){ expanded={}; folderExpanded={}; VIZ.modules.forEach(function(m){ folderExpanded[m.id.split("/")[0]]=true; }); }
  else { folderExpanded={}; expanded={}; }   // min
  rebuild(); reselect(); fitView();
};
document.getElementById("toggleCalls").onclick=function(){
  mode = mode==="coupling" ? "flow" : "coupling";
  selId=null; applyMode(); clearHL();
  this.textContent = mode==="coupling" ? "show data flow" : "show code coupling";
  document.getElementById("traceDirBtn").style.display = mode==="coupling" ? "none" : "";  // direction is a flow concept
  document.getElementById("modehint").textContent = mode==="coupling"
    ? "CODE COUPLING — lines = function calls; orange = a call crossing folders (modules reaching into each other)."
    : "DATA FLOW — lines = data moving: store reads/writes, server push/pull, DOM, + teal call-hops that carry data toward a store/server.";
};
document.getElementById("toggleCalls").textContent="show code coupling";  // default lens = data flow

// Direction toggle (flow lens): cycle goes ▸ comesFrom ▸ both, re-applying to the current selection
// (or, with nothing selected, the whole save/load pipeline).
var TRACE_LABEL={goes:"trace: where it goes ▸", comesFrom:"trace: where it comes from ▸", both:"trace: both ways ▸"};
document.getElementById("traceDirBtn").onclick=function(){
  traceDir = traceDir==="goes" ? "comesFrom" : (traceDir==="comesFrom" ? "both" : "goes");
  this.textContent = TRACE_LABEL[traceDir];
  applyTrace();
};

// Enter the IMPORT lens (module→module deps) — the honest cycle/TDZ view.
function setImportsLens(){
  mode="imports"; applyMode();
  document.getElementById("toggleCalls").textContent="show data flow";
  document.getElementById("traceDirBtn").style.display="none";
  selId=null; clearHL();
}
// Light up just the RINGS (everything else dimmed) so the loop is legible — like the old behaviour.
// Highlights the ring's member boxes + the ring's edges of the given kind (static for a real ring;
// breaker for a masked ring — the actual deferred dynamic imports holding the loop apart).
function lightRings(rings, nodeCls, edgeCls, edgeKind){
  rings.forEach(function(c){
    var set={}; c.forEach(function(m){ set["mod:"+m]=1; });
    c.forEach(function(m){ var el=cy.getElementById("mod:"+m); if(el&&el.length) el.removeClass("faded").addClass(nodeCls); });
    cy.edges('[rel = "import"][kind = "'+edgeKind+'"]').forEach(function(e){
      if(set[e.source().id()] && set[e.target().id()]) e.removeClass("faded").addClass(edgeCls);
    });
  });
}
document.getElementById("findCycles").onclick=function(){
  setImportsLens();
  var cs=VIZ.cycleSummary||{staticCycles:[],latentCycles:[],breakerCount:0,lazyCount:0};
  cy.elements().addClass("faded");
  // AMBER: rings masked by a dynamic import — glow the BREAKER edges (the deferred imports doing the
  // masking) + the ring's modules. The breakers are the actionable "what's hiding a cycle".
  lightRings(cs.latentCycles, "latentring", "latent", "breaker");
  // RED on top: real static-import rings (TDZ crash risk — the ones to actually break).
  lightRings(cs.staticCycles, "ring", "cycle", "static");
  var nReal=cs.staticCycles.length, nMask=cs.latentCycles.length;
  document.getElementById("modehint").innerHTML =
    "CIRCULAR DEPS — <b style='color:"+(nReal?"#ff5a5c":"#54c98a")+"'>real static rings (TDZ crash): "+nReal+(nReal?"":" ✓")+"</b> · "+
    "<b style='color:#f0b65e'>cycles masked by a dynamic import: "+nMask+"</b>. "+
    (nReal? "Red = crashes on load, break these. " : "")+
    "The <b style='color:#f0b65e'>bright amber dashed</b> edges are the <b>"+cs.breakerCount+" dynamic imports masking a cycle</b> — each one is a bidirectional dependency deferred to runtime (real coupling debt; amber boxes = the tangle they hold apart). "+
    "<span style='color:#5fb3a3'>"+cs.lazyCount+" lazy-loads</span> are fine — the <b>lazy-loads</b> button shows those. Click empty space to clear.";
};
document.getElementById("lazyBtn").onclick=function(){
  setImportsLens();
  cy.elements().addClass("faded");
  var lazy=cy.edges('[rel = "import"][kind = "lazy"]');
  lazy.removeClass("faded").addClass("hl");
  lazy.connectedNodes().removeClass("faded").addClass("hl");
  var cs=VIZ.cycleSummary||{lazyCount:0};
  document.getElementById("modehint").innerHTML =
    "LAZY-LOADS — <b style='color:#5fb3a3'>"+cs.lazyCount+" dynamic imports with no cycle</b> = genuine code-split points (deferred chunks). "+
    "This is your JS-loading-optimisation surface: what's pulled in on demand vs eagerly bundled.";
};

// initial view = the "default" detail level (one box per module): every folder drilled in, no module expanded.
VIZ.modules.forEach(function(m){ folderExpanded[m.id.split("/")[0]]=true; });
rebuild();
cy.fit(undefined,40);
document.getElementById("fit").onclick=function(){ cy.animate({fit:{padding:40}},{duration:300}); };
</script>
</body>
</html>
`;
}

// ── filesystem entry point ──────────────────────────────────────────

export const ARTIFACTS = {
  json: path.join(VIS_ROOT, 'generated', 'flowViz.generated.json'),
  md: path.join(VIS_ROOT, 'generated', 'FLOWMAP.generated.md'),
  html: path.join(VIS_ROOT, 'generated', 'full-stack-data-map.html'),
};

export function renderAll(viz: FlowViz = collect()) {
  return {
    json: JSON.stringify(viz, null, 2) + '\n',
    md: renderMarkdown(viz),
    html: renderHtml(viz),
  };
}

export function writeArtifacts(): FlowViz {
  const viz = collect();
  const out = renderAll(viz);
  fs.mkdirSync(path.dirname(ARTIFACTS.json), { recursive: true });
  fs.writeFileSync(ARTIFACTS.json, out.json);
  fs.writeFileSync(ARTIFACTS.md, out.md);
  fs.mkdirSync(path.dirname(ARTIFACTS.html), { recursive: true });
  fs.writeFileSync(ARTIFACTS.html, out.html);
  return viz;
}
