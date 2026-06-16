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
const EXTRA_ROOTS = [path.join(RES_ROOT, 'hyperlights'), path.join(RES_ROOT, 'hypercites'), path.join(RES_ROOT, 'divEditor'), path.join(RES_ROOT, 'editToolbar'), path.join(RES_ROOT, 'footnotes'), path.join(RES_ROOT, 'citations'), path.join(RES_ROOT, 'hyperlitContainer'), path.join(RES_ROOT, 'lazyLoader'), path.join(RES_ROOT, 'scrolling'), path.join(RES_ROOT, 'pageLoad'), path.join(RES_ROOT, 'SPA'), path.join(RES_ROOT, 'components', 'cloudRef'), path.join(RES_ROOT, 'components', 'sourceContainer'), path.join(RES_ROOT, 'components', 'userButton'), path.join(RES_ROOT, 'components', 'userContainer'), path.join(RES_ROOT, 'components', 'newBookButton'), path.join(RES_ROOT, 'components', 'newbookContainer'), path.join(RES_ROOT, 'components', 'settingsButton'), path.join(RES_ROOT, 'components', 'settingsContainer'), path.join(RES_ROOT, 'components', 'editButton'), path.join(RES_ROOT, 'components', 'tocToggleButton'), path.join(RES_ROOT, 'components', 'tocContainer'), path.join(RES_ROOT, 'components', 'utilities'), path.join(RES_ROOT, 'components', 'logoNav'), path.join(RES_ROOT, 'components', 'homepage'), path.join(RES_ROOT, 'components', 'userProfile'), path.join(RES_ROOT, 'components', 'fileDropTarget'), path.join(RES_ROOT, 'components', 'floatingActionMenu'), path.join(RES_ROOT, 'components', 'saveErrorToast'), path.join(RES_ROOT, 'components', 'togglePerimeterButtons')];

/** Per-store key + index names — what each object store holds — straight from the schema. */
const STORE_SCHEMA: Record<string, { keyPath: string; indices: string[] }> = Object.fromEntries(
  STORE_CONFIGS.map(cfg => {
    const kp = Array.isArray(cfg.keyPath) ? cfg.keyPath.join(' + ') : String(cfg.keyPath);
    const indices = (cfg.indices ?? []).map(i => (typeof i === 'string' ? i : i.name));
    return [cfg.name, { keyPath: cfg.autoIncrement ? `${kp} (auto)` : kp, indices }];
  }),
);

const STORE_SET = new Set<string>(STORE_NAMES);

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
interface EndpointMap { dir: 'push' | 'pull'; tables: string[]; }
const CORE_TABLES = ['nodes', 'hypercites', 'hyperlights', 'footnotes', 'bibliography', 'library'];
const ENDPOINT_TABLES: Record<string, EndpointMap> = {
  '/api/db/unified-sync': { dir: 'push', tables: CORE_TABLES },
  '/api/db/sync/beacon': { dir: 'push', tables: CORE_TABLES },
  '/api/db/node-chunks/targeted-upsert': { dir: 'push', tables: ['nodes'] },
  '/api/db/hypercites/upsert': { dir: 'push', tables: ['hypercites'] },
  '/api/db/hypercites/find': { dir: 'pull', tables: ['hypercites'] },
  '/api/db/hyperlights/upsert': { dir: 'push', tables: ['hyperlights'] },
  '/api/db/hyperlights/delete': { dir: 'push', tables: ['hyperlights'] },
  '/api/db/hyperlights/hide': { dir: 'push', tables: ['hyperlights'] },
  '/api/db/footnotes/upsert': { dir: 'push', tables: ['footnotes'] },
  '/api/db/references/upsert': { dir: 'push', tables: ['bibliography'] },
  '/api/database-to-indexeddb/books': { dir: 'pull', tables: CORE_TABLES },
  '/api/canonical': { dir: 'push', tables: ['canonical_source'] },
};

// ── shapes ──────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  kind: 'fn' | 'store' | 'table' | 'dom';
  /** flow-map stage for fn nodes (clusters the layout); undefined for data nodes. */
  stage?: string;
  /** owning module (file) key for fn nodes — drives collapse-to-module grouping. */
  module?: string;
  /** fn nodes only: true if it has no data edge (pure helper / orchestration). */
  leaf?: boolean;
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
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, c => walk(c, visit));
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
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

function analyzeFunctionBody(body: ts.Node): Omit<FnRaw, 'id' | 'name' | 'module' | 'exported'> {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const endpoints = new Set<string>();
  const calls = new Set<string>();
  let domRead = false;
  let domWrite = false;

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
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === 'fetch') { const url = stringLiteralValue(n.arguments[0]); if (url) endpoints.add(normalizeEndpoint(url)); }
        calls.add(callee.text);
      } else if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === 'sendBeacon') {
          walk(body, b => { const s = stringLiteralValue(b); if (s && s.startsWith('/api/')) endpoints.add(normalizeEndpoint(s)); });
        }
        if (callee.name.text === 'fetch') { const url = stringLiteralValue(n.arguments[0]); if (url) endpoints.add(normalizeEndpoint(url)); }
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
  const record = (name: string, exported: boolean, body: ts.Node) => {
    functions.push({ id: `${moduleKey}:${name}`, name, module: moduleKey, exported, ...analyzeFunctionBody(body) });
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      record(stmt.name.text, isExported(stmt), stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      const exported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) && ts.isIdentifier(decl.name)) {
          record(decl.name.text, exported, decl.initializer.body);
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
          record(`${cls}.${member.name.text}`, true, member.body);
        } else if (ts.isConstructorDeclaration(member) && member.body) {
          record(`${cls}.constructor`, true, member.body);
        } else if (ts.isPropertyDeclaration(member) && member.initializer && member.name && ts.isIdentifier(member.name)
            && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) {
          record(`${cls}.${member.name.text}`, true, member.initializer.body);
        }
      }
    }
  }
  const { staticDeps, dynDeps } = extractModuleDeps(sf, abs, known);
  return { functions, importMap, reexports: buildReexports(sf, abs, known), staticDeps, dynDeps };
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
    stageOf.has(key) || key.startsWith('hyperlights/') || key.startsWith('hypercites/') || key.startsWith('divEditor/') || key.startsWith('editToolbar/') || key.startsWith('footnotes/') || key.startsWith('citations/') || key.startsWith('hyperlitContainer/') || key.startsWith('lazyLoader/') || key.startsWith('scrolling/') || key.startsWith('pageLoad/') || key.startsWith('SPA/') || key.startsWith('components/');

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
      if (!m) continue;
      for (const t of m.tables) {
        tablesSeen.add(t);
        if (m.dir === 'push') pushEdge(fn.id, `pg:${t}`, 'push', ep);
        else pushEdge(`pg:${t}`, fn.id, 'pull', ep);
      }
    }
    for (const c of folded.exportedCalls) pushEdge(fn.id, c, 'call', undefined, reachesSink(c));
  }

  for (const { fn, hasData } of fnViews) {
    nodes.push({ id: fn.id, label: fn.name, kind: 'fn', stage: stageIdOf(fn.module), module: fn.module, leaf: !hasData });
  }
  for (const s of STORE_NAMES) nodes.push({ id: `store:${s}`, label: s, kind: 'store' });
  const tables = [...tablesSeen].sort();
  for (const t of tables) nodes.push({ id: `pg:${t}`, label: t, kind: 'table' });
  nodes.push({ id: 'dom', label: 'reader.blade.php', kind: 'dom' });

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
      fnCount: fnViews.length, moduleCount: modules.length, storeCount: STORE_NAMES.length, tableCount: tables.length,
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
  #detail{margin-top:16px;} #detail .name{font-family:ui-monospace,monospace;color:#5eb0ef;font-size:14px;word-break:break-all;}
  #detail .sub{color:var(--dim);font-size:11px;font-family:ui-monospace,monospace;margin-bottom:8px;}
  #detail h3{font-size:10px;text-transform:uppercase;color:var(--dim);letter-spacing:.05em;margin:12px 0 3px;}
  #detail ul{margin:2px 0;padding-left:16px;} #detail li{font-family:ui-monospace,monospace;font-size:11px;} #detail .none{color:var(--dim);font-style:italic;}
</style>
</head>
<body>
<div id="top">
  <h1>Full-stack data map</h1>
  <span class="meta" id="meta"></span>
  <span class="spacer"></span>
  <label class="meta">focus <select id="focus"></select></label>
  <button id="expandAll">expand all</button>
  <button id="collapseAll">collapse all</button>
  <button id="toggleCalls" title="show which functions call which — the code's internal wiring (coupling/modularity), a different lens from data flow">show code coupling</button>
  <button id="findCycles" title="IMPORT graph: red = real static-import cycles (TDZ risk to break); orange dashed = intentional dynamic cycle-breakers (debt); teal dashed = lazy-loads (fine)">find circular deps</button>
  <button id="lazyBtn" title="highlight the lazy-loads — dynamic imports with NO cycle = genuine code-split points (deferred chunks), the JS-loading-optimisation surface">lazy-loads</button>
  <button id="traceDirBtn" title="flow lens: which direction a click traces. Nothing selected = the whole save/load pipeline.">trace: where it goes ▸</button>
  <button id="fit">fit</button>
</div>
<div id="cy"></div>
<div id="side">
  <p id="modehint" style="margin:0 0 12px;padding:7px 9px;background:#1e2230;border:1px solid var(--line);border-radius:6px;font-weight:600;">DATA FLOW — lines = data moving: store reads/writes, server push/pull, DOM, + <span style="color:#5fb3a3">teal call-hops</span> that carry data toward a store/server.</p>
  <h2>Legend</h2>
  <div class="legend" id="legend"></div>
  <p id="hint"><b>Vertical position = what the code actually does</b> (read from its data edges, not its folder). Bottom→top: the page (<b>reader.blade.php</b>) ▸ code that bridges page↔IndexedDB ▸ the <b>IndexedDB</b> object stores ▸ code that bridges IndexedDB↔server ▸ <b>PostgreSQL</b> tables.<br><br><b>Horizontal column = source folder</b> (labelled across the top, and by colour): <b style="color:#9aa6bd">indexedDB</b>, <b style="color:#3fb6b6">hyperlights</b>, <b style="color:#caa14b">hypercites</b>, <b style="color:#5e8fd6">divEditor</b>. So each box's <i>column</i> is its folder and its <i>row</i> is what it does. A box sitting in a row that doesn't match its folder's natural role (e.g. a <i>hyperlights</i> file up in the IndexedDB-store row) = code acting out of role — a candidate to move when restructuring.<br><br><b>Single-click</b> to trace — and what it traces depends on the lens. In the <b>data-flow</b> lens it follows the data from there, stopping when it lands in a store/table/the page. The <b>trace:</b> button flips direction — <i>where it goes</i> (downstream) / <i>where it comes from</i> (upstream) / <i>both</i> — and re-applies live. With <b>nothing selected</b>, that button lights the whole pipeline: <i>where it goes</i> = the save flow (DOM→IndexedDB→Postgres), <i>where it comes from</i> = the load flow (Postgres→IndexedDB→DOM). Selecting a store/table/DOM itself expands from it (what reads/writes it). In the <b>coupling</b> lens it follows the <b>full dependency reach</b> (every module this one transitively touches), and <b style="color:#ff4d4f">red edges</b> mark a <b>feedback loop</b> — the path returns to where it started (a circular dependency). The rest dims but stays visible. <b>Double-click a module box</b> to drill into its files (and again to collapse). <b>Navigate:</b> scroll to zoom, drag the canvas to pan (nodes don't drag), <i>fit</i> to reset. Click a line or empty space to clear a trace.<br><br>The <b>show code coupling</b> button flips the whole map to a second lens: lines become <i>which function calls which</i> (the code's internal wiring); orange = a call crossing folders (modules reaching into each other).<br><br>The <b>find circular deps</b> button flips to the <b>IMPORT</b> lens (module→module dependencies) and tells the truth about cycles: <b style="color:#ff4d4f">red</b> = a <b>real static-import ring</b> (the only kind that risks a TDZ "Cannot access X before initialization" crash — break these); <b style="color:#e0a44b">orange dashed</b> = a <b>dynamic-import cycle-breaker</b> — a back-edge that <i>would</i> form a static ring, deferred to runtime with <code>await import()</code> (safe, but structural debt: a bidirectional import that ideally becomes one-way via events/DI); <b style="color:#5fb3a3">teal dashed</b> = a <b>lazy-load</b> — a dynamic import with no cycle (genuine code-splitting, fine). The <b>lazy-loads</b> button isolates just those teal edges — your JS-loading-optimisation surface (what's deferred into separate chunks).</p>
  <div id="detail"></div>
</div>
<script>
var VIZ = ${data};
var REL_COLOR = {read:"#5eb0ef",write:"#54c98a",push:"#e0a44b",pull:"#b07ad6",domread:"#3fb6b6",domwrite:"#e06a9a",call:"#4a5169",handoff:"#5fb3a3"};
var nodeById = {}; VIZ.nodes.forEach(function(n){ nodeById[n.id]=n; });
var fnModule = {}; VIZ.nodes.forEach(function(n){ if(n.kind==="fn") fnModule[n.id]=n.module; });
var dataIds = {}; VIZ.nodes.forEach(function(n){ if(n.kind!=="fn") dataIds[n.id]=true; });
var expanded = {};
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

function rep(id){ if(dataIds[id]) return id; var mod=fnModule[id]; if(mod==null) return id; return expanded[mod]?id:("mod:"+mod); }

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
  function buildCols(folderList, bands, colKeyOf){
    var subCols={}, startCol={}, total=0;
    folderList.forEach(function(f){
      var maxIn=1;
      bands.forEach(function(b){ var c=byBand[b].filter(function(m){return colKeyOf(m)===f;}).length; if(c>maxIn)maxIn=c; });
      subCols[f]=Math.max(1,Math.ceil(maxIn/TARGET_ROWS)); startCol[f]=total; total+=subCols[f];
    });
    return {subCols:subCols,startCol:startCol,ncols:Math.max(1,total)};
  }
  var dataCols=buildCols(folders,["sync","store","capture"],dataFolderOf);
  var compCols=buildCols(compFolders,["components"],compFolderOf);
  var NCOLS=Math.max(dataCols.ncols,compCols.ncols);
  // centre each band within the widest band's footprint (half the leftover columns)
  var dataOff=(NCOLS-dataCols.ncols)/2, compOff=(NCOLS-compCols.ncols)/2;

  // place each band's modules into their folder's sub-column(s); cumulative Y per column.
  // colKeyOf → which column a module lands in; styleFolderOf → the folder used for colour;
  // xOff → columns to shift the band right so it's horizontally centred.
  function layoutBand(mods, topY, cols, folderList, colKeyOf, styleFolderOf, xOff){
    var colY=[]; for(var c=0;c<NCOLS;c++) colY[c]=topY;
    var byFolder={}; mods.forEach(function(m){ var f=colKeyOf(m); (byFolder[f]=byFolder[f]||[]).push(m); });
    folderList.forEach(function(f){
      var list=(byFolder[f]||[]).sort(function(a,c){return a.id<c.id?-1:(a.id>c.id?1:0);});
      list.forEach(function(m,i){
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

  var SYNC_TOP=TABLEY+GAP+24;
  var syncBottom=layoutBand(byBand.sync, SYNC_TOP, dataCols, folders, dataFolderOf, dataFolderOf, dataOff);
  var STORECODE_TOP=syncBottom+GAP;
  var storeBottom=layoutBand(byBand.store, STORECODE_TOP, dataCols, folders, dataFolderOf, dataFolderOf, dataOff);
  var STOREY=storeBottom+GAP;                 // object-store barrels row (the IndexedDB level)
  var CAPTURE_TOP=STOREY+GAP;
  var capBottom=layoutBand(byBand.capture, CAPTURE_TOP, dataCols, folders, dataFolderOf, dataFolderOf, dataOff);
  var COMPONENTS_TOP=capBottom+GAP;           // components band sits directly above the DOM
  var compBottom=layoutBand(byBand.components, COMPONENTS_TOP, compCols, compFolders, compFolderOf, compStyle, compOff);
  var DOMY=compBottom+GAP;

  var fullW=STARTX+(NCOLS-1)*COLW;
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
  var tables=centreNodes(VIZ.nodes.filter(function(n){return n.kind==="table";}));
  tables.forEach(function(n,i){ els.push({data:{id:n.id,label:n.label,kind:"table"},position:{x:spread(tables.length,i),y:TABLEY}}); });
  els.push({data:{id:"dom",label:"reader.blade.php",kind:"dom"},position:{x:fullW/2,y:DOMY}});

  // folder column headers across the top (the HORIZONTAL legend)
  folders.forEach(function(f){
    var cx=STARTX+(dataOff+dataCols.startCol[f]+(dataCols.subCols[f]-1)/2)*COLW;
    els.push({data:{id:"colh:"+f,label:f,kind:"colheader",hcolor:FCOLOR[f]||"#9aa6bd"},position:{x:cx,y:TABLEY-60}});
  });
  // components sub-folder headers, sitting just above the components band
  compFolders.forEach(function(f){
    var cx=STARTX+(compOff+compCols.startCol[f]+(compCols.subCols[f]-1)/2)*COLW;
    els.push({data:{id:"colh:comp:"+f,label:f,kind:"colheader",hcolor:FCOLOR.components},position:{x:cx,y:COMPONENTS_TOP-44}});
  });

  // left-margin labels: 3 big DATA levels + 2 role labels for the code GAPS
  var labelX = STARTX - 195;
  els.push({data:{id:"tier:postgres",label:"POSTGRESQL",kind:"tier"},position:{x:labelX,y:TABLEY}});
  els.push({data:{id:"band:sync",label:"code:\\nIndexedDB ↔ server",kind:"codeband"},position:{x:labelX,y:(SYNC_TOP+syncBottom)/2}});
  els.push({data:{id:"tier:idb",label:"INDEXEDDB\\n(object stores)",kind:"tier"},position:{x:labelX,y:(STORECODE_TOP+STOREY)/2}});
  els.push({data:{id:"band:capture",label:"code:\\npage ↔ IndexedDB",kind:"codeband"},position:{x:labelX,y:(CAPTURE_TOP+capBottom)/2}});
  els.push({data:{id:"band:components",label:"code:\\nDOM components",kind:"codeband"},position:{x:labelX,y:(COMPONENTS_TOP+compBottom)/2}});
  els.push({data:{id:"tier:dom",label:"DOM\\n(reader.blade.php)",kind:"tier"},position:{x:labelX,y:DOMY}});

  // folder of an endpoint id ("mod:hyperlights/x" / "hyperlights/x:fn" → "hyperlights")
  function folderOf(id){ if(id.indexOf("mod:")===0) id=id.slice(4); return id.split("/")[0]; }
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
  // module→module IMPORT edges (the cycle/TDZ lens) — independent of expand state, between module boxes.
  (VIZ.importEdges||[]).forEach(function(e){
    var s="mod:"+e.source, t="mod:"+e.target;
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
    {selector:"node[kind = 'table']",style:{"background-color":"#3d2350","border-color":"#b07ad6","shape":"cutrectangle","padding":"10px","font-weight":"bold"}},
    {selector:"node[kind = 'dom']",style:{"background-color":"#2a3a5c","border-color":"#6f8bd6","shape":"ellipse","padding":"14px","font-weight":"bold"}},
    {selector:"node[folder = 'hyperlights']",style:{"background-color":"#143a40","border-color":"#3fb6b6","color":"#cfeaea"}},
    {selector:"node[folder = 'hypercites']",style:{"background-color":"#3a3320","border-color":"#caa14b","color":"#f0e2c2"}},
    {selector:"node[folder = 'divEditor']",style:{"background-color":"#16294a","border-color":"#5e8fd6","color":"#d4e2f5"}},
    {selector:"node[folder = 'indexedDB']",style:{"background-color":"#222b3a","border-color":"#4a5670","color":"#c8d0e0"}},
    {selector:"node[kind = 'tier']",style:{"label":"data(label)","color":"#5a6788","font-size":"28px","font-weight":"bold","background-opacity":0,"border-width":0,"text-halign":"center","text-valign":"center","text-wrap":"wrap","width":"label","height":"label","events":"no"}},
    {selector:"node[kind = 'codeband']",style:{"label":"data(label)","color":"#566688","font-size":"13px","font-weight":"bold","background-opacity":0,"border-width":0,"text-halign":"center","text-valign":"center","text-wrap":"wrap","width":"label","height":"label","events":"no"}},
    {selector:"node[kind = 'colheader']",style:{"label":"data(label)","color":"data(hcolor)","font-size":"20px","font-weight":"bold","background-opacity":0,"border-width":0,"text-halign":"center","text-valign":"center","width":"label","height":"label","events":"no"}},
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

function relabel(id){ return id.replace(/^store:|^pg:|^mod:/,""); }
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
  cy.elements().addClass("faded").removeClass("hl cycle");
  if(mode==="coupling"){
    if(!selId){ clearHL(); return; }
    var adj=buildAdj();
    var down=reachSet(selId, adj.out), up=reachSet(selId, adj.inc);
    var inTrace={}; inTrace[selId]=1;
    Object.keys(down).forEach(function(k){inTrace[k]=1;}); Object.keys(up).forEach(function(k){inTrace[k]=1;});
    var cyc={}; cyc[selId]=1; Object.keys(down).forEach(function(k){ if(up[k]) cyc[k]=1; });
    Object.keys(inTrace).forEach(function(k){ var el=cy.getElementById(k); if(el&&el.length) el.removeClass("faded").addClass("hl"); });
    cy.edges(lensEdgeSel()).forEach(function(e){ var s=e.source().id(), t=e.target().id(); if(inTrace[s]&&inTrace[t]){ e.removeClass("faded").addClass("hl"); if(cyc[s]&&cyc[t]) e.addClass("cycle"); } });
    return;
  }
  var useOut = traceDir!=="comesFrom", useIn = traceDir!=="goes";
  if(selId){
    paintTrace(flowReach([selId], useOut, useIn, true));         // node: stop where data lands
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

function showDetail(n){
  var d=document.getElementById("detail"); var id=n.id(); var kind=n.data("kind");
  if(kind==="store"||kind==="table"||kind==="dom"){
    var movers=[]; VIZ.edges.forEach(function(e){ if(e.source===id) movers.push(relabel(e.target)+"  ("+e.rel+")"); if(e.target===id) movers.push(relabel(e.source)+"  ("+e.rel+")"); });
    var schemaHtml="";
    if(kind==="store"){ var sc=VIZ.storeSchema[n.data("label")]; if(sc){ schemaHtml="<h3>key</h3><ul><li>"+sc.keyPath+"</li></ul><h3>indexes</h3>"+ul(sc.indices); } }
    d.innerHTML="<div class='name'>"+n.data("label")+"</div><div class='sub'>"+(kind==="store"?"IndexedDB object store":kind==="table"?"PostgreSQL table":"the reader page — every DOM-manipulation module reads/writes it")+"</div>"+schemaHtml+"<h3>connected functions</h3>"+ul(movers);
    return;
  }
  var ids, title, sub;
  if(kind==="module"){ var mid=id.slice(4); var mod=VIZ.modules.filter(function(m){return m.id===mid;})[0]; ids=mod?mod.fnIds:[]; title=mid; sub=(mod?mod.stage:"")+" · "+ids.length+" functions"; }
  else { ids=[id]; title=n.data("label"); sub=(n.data("stage")||"")+" · "+id.split(":")[0]; }
  var g=groupsFor(ids);
  d.innerHTML="<div class='name'>"+title+"</div><div class='sub'>"+sub+"</div>"+
    "<h3>reads (store → fn)</h3>"+ul(g.read)+
    "<h3>writes (fn → store)</h3>"+ul(g.write)+
    "<h3>DOM</h3>"+ul(g.dom)+
    "<h3>postgres (via PHP)</h3>"+ul(g.push.concat(g.pull))+
    (kind==="module"?"":"<h3>calls</h3>"+ul(g.call));
}

// ONE consistent rule: single click = trace data flow + detail (anything, modules too).
// Double click a MODULE = drill into / collapse its files (the only thing that re-lays-out).
var lastTap={id:null,t:0};
cy.on("tap","node",function(ev){
  var n=ev.target, id=n.id(), kind=n.data("kind");
  if(kind==="tier" || kind==="codeband" || kind==="colheader") return;
  var now=Date.now(), isDouble=(lastTap.id===id && now-lastTap.t<350); lastTap={id:id,t:now};
  if(isDouble && kind==="module"){
    var mid=id.slice(4); if(expanded[mid]) delete expanded[mid]; else expanded[mid]=true;
    selId=null; rebuild(); clearHL();
    var mod=cy.getElementById("mod:"+mid); if(mod&&mod.length) showDetail(mod);
    return;
  }
  highlight(n); showDetail(n);
});
cy.on("tap",function(ev){ if(ev.target===cy || (ev.target.isEdge && ev.target.isEdge())){ selId=null; clearHL(); } });

document.getElementById("meta").textContent=VIZ.meta.dbName+" v"+VIZ.meta.dbVersion+" · "+VIZ.meta.fnCount+" fns / "+VIZ.meta.moduleCount+" modules · "+VIZ.meta.storeCount+" stores · "+VIZ.meta.tableCount+" tables";
var leg=document.getElementById("legend"); VIZ.legend.forEach(function(l){ var row=document.createElement("div"); row.innerHTML="<span class='sw' style='border-top-color:"+REL_COLOR[l.rel]+"'></span><b>"+l.rel+"</b> &nbsp;"+l.from+"→"+l.to; leg.appendChild(row); });
var sel=document.getElementById("focus"); var o0=document.createElement("option"); o0.value=""; o0.textContent="(all)"; sel.appendChild(o0);
VIZ.nodes.filter(function(n){return n.kind!=="fn";}).forEach(function(n){ var o=document.createElement("option"); o.value=n.id; o.textContent=n.kind+": "+n.label; sel.appendChild(o); });
sel.onchange=function(){ clearHL(); if(!sel.value) return; var n=cy.getElementById(sel.value); if(!n||!n.length) return; cy.elements().addClass("faded"); n.closedNeighborhood().removeClass("faded").addClass("hl"); cy.animate({fit:{eles:n.closedNeighborhood(),padding:60}},{duration:300}); };
document.getElementById("expandAll").onclick=function(){ VIZ.modules.forEach(function(m){expanded[m.id]=true;}); rebuild(); clearHL(); };
document.getElementById("collapseAll").onclick=function(){ expanded={}; rebuild(); clearHL(); };
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
