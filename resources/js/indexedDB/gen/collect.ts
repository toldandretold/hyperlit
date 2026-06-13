/**
 * Data-flow graph generator for the IndexedDB layer.
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
 *   - flowViz.generated.json ... the {nodes, modules, edges} graph
 *   - FLOWMAP.generated.md ..... per-function data-flow listing
 *   - docs/idb-flow.html ....... interactive cytoscape diagram (collapse/expand)
 *
 * PURE on import; only writeArtifacts() touches disk. Deterministic (no
 * Date/random) so the no-drift gate can byte-compare.
 */
/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { FLOW_STAGES } from '../flowMap';
import { STORE_CONFIGS, DB_VERSION } from '../core/connection';
import { DB_NAME, STORE_NAMES } from '../types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDB_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(IDB_ROOT, '../../..');

// keep STORE_CONFIGS referenced so the schema source stays pinned to this file
void STORE_CONFIGS;

const STORE_SET = new Set<string>(STORE_NAMES);

const WRITE_OPS = new Set(['put', 'add', 'delete', 'clear']);
const READ_OPS = new Set(['get', 'getAll', 'getAllKeys', 'getKey', 'count', 'openCursor', 'openKeyCursor', 'index']);

const DOM_READ_METHODS = new Set([
  'querySelector', 'querySelectorAll', 'getElementById', 'closest', 'getAttribute',
  'matches', 'getElementsByClassName', 'getElementsByTagName', 'cloneNode',
]);
const DOM_WRITE_METHODS = new Set([
  'appendChild', 'removeChild', 'replaceChild', 'insertBefore', 'setAttribute',
  'removeAttribute', 'remove', 'append', 'prepend', 'before', 'after',
  'insertAdjacentHTML', 'replaceWith',
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
  fnIds: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** read | write | push | pull | domread | domwrite | call */
  rel: string;
  label?: string;
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
  nodes: GraphNode[];
  modules: GraphModule[];
  edges: GraphEdge[];
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

interface ModuleParse { functions: FnRaw[]; importMap: Map<string, string>; }

function moduleKeyOf(abs: string): string {
  return path.relative(IDB_ROOT, abs).replace(/\.(js|ts)$/, '').split(path.sep).join('/');
}

function resolveSpecToModule(fromAbs: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const key = path.relative(IDB_ROOT, path.resolve(path.dirname(fromAbs), spec)).split(path.sep).join('/');
  return known.has(key) ? key : null;
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
    }
  }
  return { functions, importMap };
}

// ── the collector ───────────────────────────────────────────────────

export function collect(): FlowViz {
  const stageOf = new Map<string, { id: string; title: string }>();
  for (const stage of FLOW_STAGES) for (const m of stage.modules) stageOf.set(m.path, { id: stage.id, title: stage.title });

  const allFiles: string[] = [];
  (function rec(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (/\.(js|ts)$/.test(e.name)) allFiles.push(full);
    }
  })(IDB_ROOT);
  const known = new Set(allFiles.map(moduleKeyOf));

  const fnReg = new Map<string, FnRaw>();
  const importMaps = new Map<string, Map<string, string>>();
  for (const abs of allFiles) {
    const key = moduleKeyOf(abs);
    if (!stageOf.has(key)) continue;
    const parsed = parseModule(abs, known);
    importMaps.set(key, parsed.importMap);
    for (const fn of parsed.functions) fnReg.set(fn.id, fn);
  }

  for (const fn of fnReg.values()) {
    const imap = importMaps.get(fn.module);
    const resolved = new Set<string>();
    for (const name of fn.calls) {
      const viaImport = imap?.get(name);
      if (viaImport && fnReg.has(viaImport)) resolved.add(viaImport);
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
  const pushEdge = (source: string, target: string, rel: string, label?: string) => {
    const id = `${source}__${rel}__${target}`;
    if (edgeKey.has(id)) return;
    edgeKey.add(id);
    edges.push({ id, source, target, rel, ...(label ? { label } : {}) });
  };

  const exportedFns = [...fnReg.values()].filter(f => f.exported).sort((a, b) => a.id.localeCompare(b.id));
  interface FnView { fn: FnRaw; folded: Folded; hasData: boolean; }
  const fnViews: FnView[] = exportedFns.map(fn => {
    const folded = fold(fn.id);
    const hasData = folded.reads.size > 0 || folded.writes.size > 0 || folded.endpoints.size > 0 || folded.domRead || folded.domWrite;
    return { fn, folded, hasData };
  });

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
    for (const c of folded.exportedCalls) pushEdge(fn.id, c, 'call');
  }

  for (const { fn, hasData } of fnViews) {
    nodes.push({ id: fn.id, label: fn.name, kind: 'fn', stage: stageOf.get(fn.module)?.id, module: fn.module, leaf: !hasData });
  }
  for (const s of STORE_NAMES) nodes.push({ id: `store:${s}`, label: s, kind: 'store' });
  const tables = [...tablesSeen].sort();
  for (const t of tables) nodes.push({ id: `pg:${t}`, label: t, kind: 'table' });
  nodes.push({ id: 'dom', label: 'DOM / editor', kind: 'dom' });

  const moduleMap = new Map<string, GraphModule>();
  for (const { fn } of fnViews) {
    let mod = moduleMap.get(fn.module);
    if (!mod) { mod = { id: fn.module, label: fn.module, stage: stageOf.get(fn.module)?.id ?? 'infra', fnIds: [] }; moduleMap.set(fn.module, mod); }
    mod.fnIds.push(fn.id);
  }
  const modules = [...moduleMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  modules.forEach(m => m.fnIds.sort());

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    meta: {
      dbName: DB_NAME, dbVersion: DB_VERSION,
      fnCount: fnViews.length, moduleCount: modules.length, storeCount: STORE_NAMES.length, tableCount: tables.length,
      edgeCount: edges.length,
      sources: ['exported functions (TS AST)', 'core/connection STORE_CONFIGS', 'real fetch/sendBeacon → PG tables (Eloquent $table names)', 'flowMap.ts (stage clustering)'],
      note: 'GENERATED by resources/js/indexedDB/gen/collect.ts — do not edit. Run `npm run viz:idb`.',
    },
    stageOrder: FLOW_STAGES.map(s => s.id),
    legend: [
      { rel: 'read', from: 'store', to: 'fn', desc: 'function reads an IndexedDB object store' },
      { rel: 'write', from: 'fn', to: 'store', desc: 'function writes an IndexedDB object store' },
      { rel: 'push', from: 'fn', to: 'table', desc: 'function pushes to a Postgres table (POST, via PHP)' },
      { rel: 'pull', from: 'table', to: 'fn', desc: 'function pulls from Postgres (GET, via PHP)' },
      { rel: 'domread', from: 'dom', to: 'fn', desc: 'function reads the DOM' },
      { rel: 'domwrite', from: 'fn', to: 'dom', desc: 'function writes the DOM' },
      { rel: 'call', from: 'fn', to: 'fn', desc: 'function calls another (data handoff)' },
    ],
    nodes, modules, edges,
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
  L.push('<!-- GENERATED by resources/js/indexedDB/gen/collect.ts — do not edit. Run `npm run viz:idb`. -->');
  L.push('');
  L.push('# IndexedDB layer — data-flow graph');
  L.push('');
  L.push(`**${viz.meta.dbName}** schema v${viz.meta.dbVersion} · ` +
    `${viz.meta.fnCount} functions in ${viz.meta.moduleCount} modules · ` +
    `${viz.meta.storeCount} object stores · ${viz.meta.tableCount} PG tables · ${viz.meta.edgeCount} edges`);
  L.push('');
  L.push('Data moves DOM (bottom) → functions → IndexedDB object stores → PostgreSQL tables (top), via JS here and PHP at the API seam. Interactive (collapse/expand by module): `docs/idb-flow.html`.');
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
<!-- GENERATED by resources/js/indexedDB/gen/collect.ts — do not edit. Run \`npm run viz:idb\`. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IndexedDB layer — data-flow graph</title>
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
  <h1>IndexedDB data-flow</h1>
  <span class="meta" id="meta"></span>
  <span class="spacer"></span>
  <label class="meta">focus <select id="focus"></select></label>
  <button id="expandAll">expand all</button>
  <button id="collapseAll">collapse all</button>
  <button id="toggleCalls">hide call edges</button>
  <button id="fit">fit</button>
</div>
<div id="cy"></div>
<div id="side">
  <h2>Legend</h2>
  <div class="legend" id="legend"></div>
  <p id="hint">Click a <b>module</b> box to expand its functions (click again to collapse). Click a function/store/table to trace its data.</p>
  <div id="detail"></div>
</div>
<script>
var VIZ = ${data};
var REL_COLOR = {read:"#5eb0ef",write:"#54c98a",push:"#e0a44b",pull:"#b07ad6",domread:"#3fb6b6",domwrite:"#e06a9a",call:"#4a5169"};
var nodeById = {}; VIZ.nodes.forEach(function(n){ nodeById[n.id]=n; });
var fnModule = {}; VIZ.nodes.forEach(function(n){ if(n.kind==="fn") fnModule[n.id]=n.module; });
var dataIds = {}; VIZ.nodes.forEach(function(n){ if(n.kind!=="fn") dataIds[n.id]=true; });
var expanded = {};
var callsHidden = false;

function rep(id){ if(dataIds[id]) return id; var mod=fnModule[id]; if(mod==null) return id; return expanded[mod]?id:("mod:"+mod); }

function rebuild(){
  var COLW=270, ROWH=44, MODH=34, STARTX=150, JSTOP=400, TABLEY=70, STOREY=240;
  var els=[];
  var byStage={}; VIZ.stageOrder.forEach(function(s){byStage[s]=[];});
  VIZ.modules.forEach(function(m){ if(!byStage[m.stage]) byStage[m.stage]=[]; byStage[m.stage].push(m); });
  var maxBottom=JSTOP;
  VIZ.stageOrder.forEach(function(stage,ci){
    var colX=STARTX+ci*COLW, y=JSTOP;
    var mods=(byStage[stage]||[]).slice().sort(function(a,b){return a.id<b.id?-1:(a.id>b.id?1:0);});
    mods.forEach(function(m){
      if(expanded[m.id]){
        els.push({data:{id:"mod:"+m.id,label:m.label,kind:"module",expanded:1,stage:stage}});
        var sy=y+30;
        m.fnIds.forEach(function(fid,i){ var n=nodeById[fid]; els.push({data:{id:fid,label:n.label,kind:"fn",parent:"mod:"+m.id,stage:stage,leaf:n.leaf?1:0},position:{x:colX,y:sy+i*ROWH}}); });
        y=sy+m.fnIds.length*ROWH+30;
      } else {
        els.push({data:{id:"mod:"+m.id,label:m.label+"  ("+m.fnIds.length+")",kind:"module",expanded:0,stage:stage},position:{x:colX,y:y}});
        y+=MODH+14;
      }
    });
    if(y>maxBottom)maxBottom=y;
  });
  var fullW=STARTX+(VIZ.stageOrder.length-1)*COLW;
  var DOMY=maxBottom+90;
  function spread(n,i){ return STARTX+(n<=1?fullW/2:(i*fullW)/(n-1)); }
  var stores=VIZ.nodes.filter(function(n){return n.kind==="store";});
  stores.forEach(function(n,i){ els.push({data:{id:n.id,label:n.label,kind:"store"},position:{x:spread(stores.length,i),y:STOREY}}); });
  var tables=VIZ.nodes.filter(function(n){return n.kind==="table";});
  tables.forEach(function(n,i){ els.push({data:{id:n.id,label:n.label,kind:"table"},position:{x:spread(tables.length,i),y:TABLEY}}); });
  els.push({data:{id:"dom",label:"DOM / editor",kind:"dom"},position:{x:fullW/2,y:DOMY}});
  var seen={};
  VIZ.edges.forEach(function(e){
    var s=rep(e.source), t=rep(e.target);
    if(!s||!t||s===t) return;
    var k=s+"|"+t+"|"+e.rel;
    if(seen[k]) return; seen[k]=true;
    els.push({data:{id:k,source:s,target:t,rel:e.rel,label:e.label||""}});
  });
  cy.json({elements:els});
  cy.style().update();
  if(callsHidden) cy.edges("[rel = 'call']").style("display","none");
  cy.layout({name:"preset"}).run();
}

var cy = cytoscape({
  container: document.getElementById("cy"),
  elements: [],
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
    {selector:"edge",style:{"width":1.4,"curve-style":"bezier","target-arrow-shape":"triangle","arrow-scale":0.8,"line-color":"#4a5169","target-arrow-color":"#4a5169","opacity":0.75}},
    {selector:"edge[rel = 'read']",style:{"line-color":REL_COLOR.read,"target-arrow-color":REL_COLOR.read}},
    {selector:"edge[rel = 'write']",style:{"line-color":REL_COLOR.write,"target-arrow-color":REL_COLOR.write}},
    {selector:"edge[rel = 'push']",style:{"line-color":REL_COLOR.push,"target-arrow-color":REL_COLOR.push,"width":2.2}},
    {selector:"edge[rel = 'pull']",style:{"line-color":REL_COLOR.pull,"target-arrow-color":REL_COLOR.pull,"width":2.2}},
    {selector:"edge[rel = 'domread']",style:{"line-color":REL_COLOR.domread,"target-arrow-color":REL_COLOR.domread}},
    {selector:"edge[rel = 'domwrite']",style:{"line-color":REL_COLOR.domwrite,"target-arrow-color":REL_COLOR.domwrite}},
    {selector:"edge[rel = 'call']",style:{"line-color":REL_COLOR.call,"target-arrow-color":REL_COLOR.call,"line-style":"dashed","opacity":0.4,"arrow-scale":0.6}},
    {selector:".faded",style:{"opacity":0.07}},
    {selector:"node.hl",style:{"border-width":2.5,"border-color":"#fff","opacity":1}},
    {selector:"edge.hl",style:{"opacity":1,"width":2.6}}
  ],
  layout:{name:"preset"}
});

function relabel(id){ return id.replace(/^store:|^pg:|^mod:/,""); }
function clearHL(){ cy.elements().removeClass("faded hl"); }
function highlight(n){ cy.elements().addClass("faded").removeClass("hl"); var nb=n.closedNeighborhood(); nb.removeClass("faded").addClass("hl"); }

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
    d.innerHTML="<div class='name'>"+n.data("label")+"</div><div class='sub'>"+(kind==="store"?"IndexedDB object store":kind==="table"?"PostgreSQL table":"DOM")+"</div><h3>connected functions</h3>"+ul(movers);
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

cy.on("tap","node",function(ev){
  var n=ev.target, id=n.id();
  if(n.data("kind")==="module"){ var mid=id.slice(4); if(expanded[mid]) delete expanded[mid]; else expanded[mid]=true; rebuild(); clearHL(); showDetail(n.data("expanded")?cy.getElementById("mod:"+mid):n); return; }
  highlight(n); showDetail(n);
});
cy.on("tap",function(ev){ if(ev.target===cy) clearHL(); });

document.getElementById("meta").textContent=VIZ.meta.dbName+" v"+VIZ.meta.dbVersion+" · "+VIZ.meta.fnCount+" fns / "+VIZ.meta.moduleCount+" modules · "+VIZ.meta.storeCount+" stores · "+VIZ.meta.tableCount+" tables";
var leg=document.getElementById("legend"); VIZ.legend.forEach(function(l){ var row=document.createElement("div"); row.innerHTML="<span class='sw' style='border-top-color:"+REL_COLOR[l.rel]+"'></span><b>"+l.rel+"</b> &nbsp;"+l.from+"→"+l.to; leg.appendChild(row); });
var sel=document.getElementById("focus"); var o0=document.createElement("option"); o0.value=""; o0.textContent="(all)"; sel.appendChild(o0);
VIZ.nodes.filter(function(n){return n.kind!=="fn";}).forEach(function(n){ var o=document.createElement("option"); o.value=n.id; o.textContent=n.kind+": "+n.label; sel.appendChild(o); });
sel.onchange=function(){ clearHL(); if(!sel.value) return; var n=cy.getElementById(sel.value); if(!n||!n.length) return; cy.elements().addClass("faded"); n.closedNeighborhood().removeClass("faded").addClass("hl"); cy.animate({fit:{eles:n.closedNeighborhood(),padding:60}},{duration:300}); };
document.getElementById("expandAll").onclick=function(){ VIZ.modules.forEach(function(m){expanded[m.id]=true;}); rebuild(); clearHL(); };
document.getElementById("collapseAll").onclick=function(){ expanded={}; rebuild(); clearHL(); };
document.getElementById("toggleCalls").onclick=function(){ callsHidden=!callsHidden; cy.edges("[rel = 'call']").style("display",callsHidden?"none":"element"); this.textContent=callsHidden?"show call edges":"hide call edges"; };
document.getElementById("fit").onclick=function(){ cy.animate({fit:{padding:40}},{duration:300}); };

rebuild();
cy.fit(undefined,40);
</script>
</body>
</html>
`;
}

// ── filesystem entry point ──────────────────────────────────────────

export const ARTIFACTS = {
  json: path.join(IDB_ROOT, 'flowViz.generated.json'),
  md: path.join(IDB_ROOT, 'FLOWMAP.generated.md'),
  html: path.join(REPO_ROOT, 'docs/idb-flow.html'),
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
  fs.writeFileSync(ARTIFACTS.json, out.json);
  fs.writeFileSync(ARTIFACTS.md, out.md);
  fs.mkdirSync(path.dirname(ARTIFACTS.html), { recursive: true });
  fs.writeFileSync(ARTIFACTS.html, out.html);
  return viz;
}
