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
      if (e.rel === 'push') { expect(byId[e.source].kind).toBe('fn'); expect(byId[e.target].kind).toBe('table'); }
      if (e.rel === 'pull') { expect(byId[e.source].kind).toBe('table'); expect(byId[e.target].kind).toBe('fn'); }
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
