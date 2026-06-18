/**
 * Generator + no-drift gate for the IndexedDB visualisation
 * (mirrors app/Python's gen_pipeline_*.py + their no-drift tests).
 *
 *   - `npm run viz:idb` (WRITE_FLOWVIZ=1) regenerates the three artifacts.
 *   - plain `npm test` regenerates IN MEMORY and asserts the on-disk artifacts
 *     match — a stale diagram fails CI, so the committed files can be trusted.
 *
 * The generator is deterministic (no Date/random), so equal inputs → equal bytes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { collect, renderAll, writeArtifacts, ARTIFACTS } from '../../../visualisation/js/collect';

if (process.env.WRITE_FLOWVIZ) {
  const viz = writeArtifacts();
  // eslint-disable-next-line no-console
  console.log(
    `\n✅ wrote IndexedDB flow viz — ${viz.meta.fnCount} functions in ${viz.meta.moduleCount} modules, ` +
    `${viz.meta.storeCount} stores, ${viz.meta.tableCount} PG tables, ${viz.meta.edgeCount} edges` +
    `\n   ${ARTIFACTS.json}\n   ${ARTIFACTS.md}\n   ${ARTIFACTS.html}\n`,
  );
}

describe('IndexedDB flow viz', () => {
  it('collects a coherent data-flow graph (fn/store/table/dom nodes + directed edges)', () => {
    const viz = collect();
    const byId = Object.fromEntries(viz.nodes.map(n => [n.id, n]));
    const kinds = viz.nodes.reduce((a, n) => ((a[n.kind] = (a[n.kind] || 0) + 1), a), {});

    expect(kinds.fn).toBeGreaterThan(0);
    expect(kinds.store).toBe(8);   // pinned schema store count
    expect(kinds.dom).toBe(1);
    expect(kinds.table).toBeGreaterThan(0);
    expect(viz.edges.length).toBeGreaterThan(0);

    // every edge connects two real nodes
    for (const e of viz.edges) {
      expect(byId[e.source], `edge source ${e.source}`).toBeTruthy();
      expect(byId[e.target], `edge target ${e.target}`).toBeTruthy();
    }
    // data-direction invariants: writes/pushes leave a fn; reads/pulls enter a fn
    for (const e of viz.edges) {
      if (e.rel === 'write') { expect(byId[e.source].kind).toBe('fn'); expect(byId[e.target].kind).toBe('store'); }
      if (e.rel === 'read') { expect(byId[e.source].kind).toBe('store'); expect(byId[e.target].kind).toBe('fn'); }
      // push/pull route through the API endpoint AND the Laravel controller tier:
      // push: fn → route → controller → table ; pull: table → controller → route → fn.
      // So both ends are drawn from {fn, route, controller, table} per direction.
      if (e.rel === 'push') { expect(['fn', 'route', 'controller']).toContain(byId[e.source].kind); expect(['route', 'controller', 'table']).toContain(byId[e.target].kind); }
      if (e.rel === 'pull') { expect(['table', 'controller', 'route']).toContain(byId[e.source].kind); expect(['route', 'controller', 'fn']).toContain(byId[e.target].kind); }
    }

    // ground truth: a read-only reader reads `nodes`; the sync pushes to the `nodes` table
    // (the PG table is `nodes`, NOT node_chunks — verified against Eloquent $table).
    const reads = viz.edges.filter(e => e.rel === 'read').map(e => `${e.source}->${e.target}`);
    expect(reads.some(r => r.startsWith('store:nodes->') && /getNodeChunksFromIndexedDB/.test(r))).toBe(true);
    const pushes = viz.edges.filter(e => e.rel === 'push');
    expect(pushes.some(e => e.target === 'pg:nodes')).toBe(true);
    // and there is no phantom node_chunks table
    expect(viz.nodes.some(n => n.id === 'pg:node_chunks')).toBe(false);

    // collapse-by-module grouping is present and every fn belongs to a module
    expect(viz.modules.length).toBeGreaterThan(0);
    const fnIds = new Set(viz.nodes.filter(n => n.kind === 'fn').map(n => n.id));
    const grouped = new Set(viz.modules.flatMap(m => m.fnIds));
    for (const id of fnIds) expect(grouped.has(id), `${id} should belong to a module`).toBe(true);
  });

  it('type-trace capture: nodes table + its handler fns carry the welded node-data types', () => {
    const viz = collect();
    const byId = Object.fromEntries(viz.nodes.map(n => [n.id, n]));

    // The `nodes` PG table advertises its full TS row-data lineage (PG↔IDB↔DOM).
    const nodesTable = byId['pg:nodes'];
    expect(nodesTable.types).toBeTruthy();
    for (const t of ['NodeRecord', 'ServerNodeRow', 'PublicChunk', 'NodeHyperlightView', 'NodeHyperciteView']) {
      expect(nodesTable.types, `pg:nodes should carry ${t}`).toContain(t);
    }

    // Key lineage functions are tagged with the node types they handle (read from signatures/bodies).
    const fnByLabel = l => viz.nodes.find(n => n.kind === 'fn' && n.label === l);
    expect(fnByLabel('createChunkElement').types).toContain('NodeRecord');          // IDB → DOM render
    expect(fnByLabel('getNodeChunksFromIndexedDB').types).toContain('NodeRecord');  // IDB read
    expect(fnByLabel('toPublicChunk').types).toEqual(expect.arrayContaining(['NodeRecord', 'PublicChunk']));
    expect(fnByLabel('loadNodeChunksToIndexedDB').types).toContain('ServerNodeRow'); // wire in (+ nested processNode)

    // types arrays are deduped + sorted (determinism — the byte-gate depends on stable order)
    for (const n of viz.nodes) {
      if (!n.types) continue;
      expect(n.types, `${n.id} types sorted`).toEqual([...n.types].sort());
      expect(new Set(n.types).size, `${n.id} types deduped`).toBe(n.types.length);
    }
  });

  it('type-trace capture: library table + its handler fns carry the welded library types', () => {
    const viz = collect();
    const byId = Object.fromEntries(viz.nodes.map(n => [n.id, n]));

    // The `library` PG table advertises its TS lineage (wire-in ServerLibraryRow → store/save LibraryRecord).
    const libraryTable = byId['pg:library'];
    expect(libraryTable.types).toEqual(['LibraryRecord', 'ServerLibraryRow']);  // sorted

    const fnByLabel = l => viz.nodes.find(n => n.kind === 'fn' && n.label === l);
    expect(fnByLabel('loadLibraryToIndexedDB').types).toContain('ServerLibraryRow');           // wire in (PG → IDB)
    expect(fnByLabel('prepareLibraryForIndexedDB').types).toEqual(expect.arrayContaining(['ServerLibraryRow', 'LibraryRecord'])); // the weld
    expect(fnByLabel('getLibraryObjectFromIndexedDB').types).toContain('LibraryRecord');       // IDB read
    expect(fnByLabel('buildSourceHtml').types).toContain('LibraryRecord');                     // IDB → DOM render
    expect(fnByLabel('syncLibraryRecordToBackend').types).toContain('LibraryRecord');          // save (IDB → PG)
  });

  it('API route tier: endpoints carry precise per-endpoint tables (no coarse fan-out)', () => {
    const viz = collect();
    const routes = viz.nodes.filter(n => n.kind === 'route');
    expect(routes.length).toBeGreaterThan(0);
    // tables an endpoint touches, NOW via the controller hop: route → controller → pg:<table>
    // (with a fallback to any direct route↔table edge for routes that have no backend controller).
    const adj = id => viz.edges
      .filter(e => (e.source === id || e.target === id) && (e.rel === 'push' || e.rel === 'pull'))
      .map(e => (e.source === id ? e.target : e.source));
    const tablesOf = routeId => {
      const out = new Set();
      for (const n of adj(routeId)) {
        if (n.startsWith('pg:')) out.add(n.slice(3));
        else if (n.startsWith('controller:')) for (const m of adj(n)) if (m.startsWith('pg:')) out.add(m.slice(3));
      }
      return out;
    };
    const route = suffix => viz.nodes.find(n => n.kind === 'route' && n.id.endsWith(suffix));

    // annotations endpoint carries the annotation tables and NOT the author's content
    // (nodes/footnotes/bibliography) — the content-vs-annotations split still holds through
    // the controller. (It also reads `library` for the visibility/ownership check — incidental.)
    const ann = route('/annotations');
    expect(ann.group).toBe('annotations');
    const annTables = tablesOf(ann.id);
    expect(annTables.has('hyperlights')).toBe(true);
    expect(annTables.has('hypercites')).toBe(true);
    for (const content of ['nodes', 'footnotes', 'bibliography']) expect(annTables.has(content)).toBe(false);
    // the library fetch carries library, never the author's nodes
    expect(tablesOf(route('/library').id).has('library')).toBe(true);
    expect(tablesOf(route('/library').id).has('nodes')).toBe(false);
    // the full-book load is content + carries nodes
    const data = route('/data');
    expect(data.group).toBe('content');
    expect(tablesOf(data.id).has('nodes')).toBe(true);
  });

  it('backend tier: Laravel controllers bridge the routes to the PG tables (nodes read + write)', () => {
    const viz = collect();
    const byId = Object.fromEntries(viz.nodes.map(n => [n.id, n]));
    const controllers = viz.nodes.filter(n => n.kind === 'controller');
    expect(controllers.length).toBeGreaterThan(0);

    // every controller connects to ≥1 pg:<table> (push/pull only). A route edge is present only for
    // controllers on a data-layer-detected route (others are real backend endpoints the reader page
    // doesn't fetch — e.g. DbLibraryController, called from the book-create / edit-form flows).
    for (const c of controllers) {
      const touches = viz.edges.filter(e => e.source === c.id || e.target === c.id);
      expect(touches.length, `${c.id} is wired`).toBeGreaterThan(0);
      expect(touches.every(e => e.rel === 'push' || e.rel === 'pull'), `${c.id} only push/pull`).toBe(true);
      expect(touches.some(e => (e.source.startsWith('pg:') || e.target.startsWith('pg:'))), `${c.id} has a table`).toBe(true);
    }

    const tablesOf = id => viz.edges
      .filter(e => (e.source === id || e.target === id) && (e.rel === 'push' || e.rel === 'pull'))
      .map(e => (e.source === id ? e.target : e.source))
      .filter(x => x.startsWith('pg:')).map(x => x.slice(3));

    // READ side: getBookData pulls the `nodes` table (the author's content load).
    const read = byId['controller:DatabaseToIndexedDBController@getBookData'];
    expect(read).toBeTruthy();
    expect(read.dir).toBe('pull');
    expect(tablesOf(read.id)).toContain('nodes');

    // WRITE side: the node save the front end actually calls is the targeted upsert (push → nodes).
    const write = byId['controller:DbNodeChunkController@targetedUpsert'];
    expect(write).toBeTruthy();
    expect(write.dir).toBe('push');
    expect(tablesOf(write.id)).toContain('nodes');

    // the node read controller carries the welded node-row shape (so its data is legible).
    expect(read.shape).toEqual(expect.arrayContaining(['content', 'startLine', 'chunk_id', 'node_id']));
    // and it lights up the `nodes` type-trace (carries the row's TS lineage types).
    expect(read.types).toContain('NodeRecord');
  });

  it('import graph: NO real static-import cycles, every import edge classified', () => {
    const viz = collect();
    // The honest cycle detector: static-import rings are the only TDZ risk. We keep this at 0
    // (dynamic-import breakers/lazy-loads are intentional and don't crash). A regression here
    // means someone reintroduced a circular static import. The render layer (lazyLoader/scrolling/
    // pageLoad) was de-cycled via DI (lazyLoader is a leaf — attachers injected) + dynamic imports
    // for the few feature→bootstrap back-edges, so this enforces zero static cycles GLOBALLY.
    expect(viz.cycleSummary.staticCycles, JSON.stringify(viz.cycleSummary.staticCycles)).toEqual([]);
    expect(typeof viz.cycleSummary.breakerCount).toBe('number');
    expect(typeof viz.cycleSummary.lazyCount).toBe('number');

    const moduleIds = new Set(viz.modules.map(m => m.id));
    for (const e of viz.importEdges) {
      expect(['static', 'breaker', 'lazy']).toContain(e.kind);
      expect(moduleIds.has(e.source), `import source ${e.source}`).toBe(true);
      expect(moduleIds.has(e.target), `import target ${e.target}`).toBe(true);
    }
  });

  const targets = [
    ['json', ARTIFACTS.json],
    ['md', ARTIFACTS.md],
    ['html', ARTIFACTS.html],
  ];

  for (const [kind, file] of targets) {
    it(`${kind} artifact is up to date (run \`npm run viz:idb\` if this fails)`, () => {
      expect(fs.existsSync(file), `${file} missing — run \`npm run viz:idb\``).toBe(true);
      const expected = renderAll()[kind];
      const actual = fs.readFileSync(file, 'utf8');
      expect(actual, `${file} is stale — run \`npm run viz:idb\``).toBe(expected);
    });
  }
});
