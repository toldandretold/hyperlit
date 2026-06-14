# /visualisation — codebase data-flow map

A map of how data moves through Hyperlit, **generated from the code itself** (nothing is
hand-drawn). Open **`visualisation/generated/full-stack-data-map.html`** in a browser — it's
self-contained and works over `file://`.

The goal is a single, honest picture of the data spine:

```
reader.blade.php → JS (DOM modules) → JS (IndexedDB) → [HTTP endpoint] → PHP route → Controller → Eloquent model → Postgres table
└──────────────── built today (visualisation/js) ───────────────┘   └──────────── planned next (visualisation/php) ────────────┘
```

**Today** it covers the front end end-to-end: the page, the DOM-manipulation modules
(`hyperlights` / `hypercites` / `divEditor`), the IndexedDB layer, and the API seam (the
Postgres tables each endpoint hits). **Next** is the PHP tier — routes + controllers +
Eloquent — joined onto the JS side at the shared endpoint URL (see `php/` and `merge.ts`).

> Scope discipline: this is a **data-flow** map, not "every file." Keep it to the spine —
> code that moves data across a boundary — or it stops being legible.

---

## For agents / LLMs

The `.html` is for **humans** — don't read it (it's a heavy interactive page with the data
buried in a `<script>` blob). Use the generated text instead, it's far cheaper than tracing
imports by hand:

- **`generated/FLOWMAP.generated.md`** — flat table: every function → module, stores
  read/written, DOM touch, Postgres table. Read this to orient before editing the data layer.
- **`generated/flowViz.generated.json`** — the raw `{nodes, modules, edges}` graph; filter
  it to answer "what writes store X?", "what's coupled to file Y?", "what does folder Z depend on?".

Caveats: covers only the data layer (the 4 folders + the API seam), and it's *function-level
data flow*, not business logic. It's only trustworthy because CI byte-checks it — regenerate
with `npm run viz:idb` and commit after changing scanned code. (See `Hyperlit/CLAUDE.md` for
the standing review gate.)

---

## Layout

```
visualisation/
├── js/
│   └── collect.ts          the generator (TypeScript-AST analysis of the front end)
├── php/                    PLANNED: a PHP collector (routes + controllers → endpoint/model/table)
├── merge.ts                PLANNED: join the JS + PHP graphs on endpoint URL, emit one graph
├── generated/                  ALL output (self-contained — open the .html directly)
│   ├── full-stack-data-map.html  the interactive cytoscape diagram
│   ├── vendor/cytoscape.min.js   vendored (referenced relatively so file:// stays offline)
│   ├── flowViz.generated.json    the raw {nodes, modules, edges} graph
│   └── FLOWMAP.generated.md       per-function reads/writes/DOM/Postgres table
└── README.md               this file
```

All output lives together under `generated/` — the `.html` and its vendored cytoscape, plus
the raw graph + per-function table. (`docs/` stays hand-written prose.)

---

## Run it

```bash
npm run viz:idb     # regenerate all three artifacts from the current code
npm test            # (among others) byte-checks the committed artifacts are up to date
```

All artifacts are **committed** and **byte-checked in CI**: edit analyzed code without
regenerating and `tests/javascript/visualisation/flowViz.generate.test.js` fails. Re-run
`npm run viz:idb` and commit.

---

## How to read the diagram

A 2-D grid — **both axes mean something**:

- **Vertical (row) = role** (inferred from a module's data edges, not its folder). Top→bottom:
  PostgreSQL tables ▸ code that bridges IndexedDB↔server ▸ IndexedDB stores ▸ code that
  bridges page↔IndexedDB ▸ `reader.blade.php`.
- **Horizontal (column) = source folder** under `resources/js/` (`indexedDB`, `hyperlights`,
  `hypercites`, `divEditor`) — labelled across the top and reinforced by colour.

So a box sits at **folder × role**. A box in a row that doesn't match its folder's natural
role = code acting out of place (a refactor candidate), visible at a glance.

**Two lenses** (toolbar toggle):
- **Data flow** (default) — lines are data moving (store reads/writes, server push/pull, DOM read/write).
- **Code coupling** — lines become *which function calls which*; **orange = a call crossing
  folders** (modules reaching into each other = the modularity smell).

**Interactions:** single-click traces a node's connections (rest dims but stays legible);
double-click a module box drills into its functions; expand/collapse all + fit; focus dropdown.

---

## How `js/collect.ts` works

Pure on import (only `writeArtifacts()` touches disk) and deterministic (no `Date`/`Math.random`)
so the no-drift gate can byte-compare. It walks `resources/js/indexedDB/` plus the DOM-facing
`EXTRA_ROOTS` (`hyperlights`, `hypercites`, `divEditor`, `editToolbar`) and, per **top-level
exported function AND class method** (`ClassName.method` — so class-per-file code like
editToolbar is represented, not just function-first modules), uses the **TypeScript compiler
API** (AST, not regex) to detect: stores read/written, API endpoints
(`fetch`/`sendBeacon` → Postgres tables via `ENDPOINT_TABLES`), DOM touch (incl.
selection/range/treewalker/execCommand APIs), and calls. It reads
the front-end layer's own metadata (`flowMap.ts`, `core/connection.ts` `STORE_CONFIGS`,
`types.ts`) from `resources/js/indexedDB`. Emits nodes (`fn`/`store`/`table`/`dom`), modules
(with a role `band`), and edges (`read`/`write`/`push`/`pull`/`domread`/`domwrite`/`call`).

### Extending it
- **New DOM-facing folder** → add to `EXTRA_ROOTS` + the `stageIdOf`/`isAnalyzed` prefix
  branches; add to `FOLDER_ORDER`/`FCOLOR` in the HTML renderer for its column.
- **New API endpoint** → add to `ENDPOINT_TABLES` (direction + real Postgres table; verify
  names against `app/Models/` + controllers, never guess).
- **New object store** → comes from `STORE_CONFIGS` automatically; bump the pinned store
  count in the generate test.

### Gotchas
- `collect.ts` is the only generator file using `node:*` builtins → scoped `/// <reference
  types="node" />`. It's never reached from an app entry, so Vite never bundles it.
- The embedded HTML `<script>` avoids backticks / `${}` so the outer template literal only
  interpolates the graph JSON.
- macOS `open` re-focuses an existing `file://` tab **without reloading** — hard-refresh
  (Cmd-Shift-R) after regenerating.

---

## Next: the PHP tier (`php/` + `merge.ts`)

Planned, not built. Sketch:

1. **`php/collect`** — parse `routes/api.php` (+ `web.php`) for `method + URI → Controller@method`,
   then read each controller method for the Eloquent model / `DB::table('…')` it touches.
   Parser options: [`nikic/php-parser`](https://github.com/nikic/PHP-Parser), or a small
   `artisan` command using `Route::getRoutes()` + reflection. Emit nodes `route`/`controller`/`model`
   and edges into the existing `table` nodes.
2. **`merge.ts`** — the JS graph already records each endpoint URL on its `push`/`pull` edges;
   the PHP graph keys routes by the same normalized URL. Join on it: the HTTP endpoint becomes
   a real node with JS on one side and PHP on the other. Bonus — `ENDPOINT_TABLES` (today a
   hand-maintained map) becomes **derived** from the controllers, so table names can't drift.
3. Keep the same renderer; add a PHP tier above the Postgres tables and a `controller`/`route`
   folder colour.
