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

Caveats: covers only the data layer (indexedDB + the 7 DOM/feature folders + the API seam), and
it's *function-level data flow*, not business logic. It's only trustworthy because CI byte-checks it — regenerate
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

**Three lenses** (toolbar):
- **Data flow** (default) — lines are data moving (store reads/writes, server push/pull, DOM read/write).
- **Code coupling** (`show code coupling`) — lines become *which function calls which*; **orange =
  a call crossing folders** (modules reaching into each other = the modularity smell).
- **Imports / cycles** (`find circular deps`) — module→module *import* edges, classified honestly:
  - <span style="color:#ff4d4f">**red**</span> = a **real static-import ring** — the only kind that
    can crash with a TDZ `Cannot access X before initialization`. **These are the ones to break.**
  - <span style="color:#e0a44b">**orange dashed**</span> = a **dynamic-import cycle-breaker** — a
    back-edge deferred to runtime with `await import()` because a static import there *would* form a
    ring. Safe, but **structural debt** (a bidirectional import that ideally becomes one-way via
    events/DI).
  - <span style="color:#5fb3a3">**teal dashed**</span> = a **lazy-load** — a dynamic import with no
    cycle: genuine code-splitting. The `lazy-loads` button isolates just these — your
    **JS-loading-optimisation surface** (what's deferred into separate chunks vs eagerly bundled).

  Why this matters: the naive "scan the call graph for loops" lights up every `await import()` red and
  makes a healthy codebase look broken. Only **static** imports risk TDZ; the generator separates the
  three so the button is an honest TDZ detector. Counts (cycles / breakers / lazy) show in the header
  bar and in `FLOWMAP.generated.md` (`## Import cycles & dynamic imports`).

**Interactions:** single-click traces a node's connections (rest dims but stays legible);
double-click a module box drills into its functions; expand/collapse all + fit; focus dropdown.

**Type trace (click a Postgres table):** clicking a table that has a known TS type lineage
(today: `nodes`) doesn't do the generic edge-trace — it lights the **functions that actually handle
that data type**, read from the TypeScript annotations (`collect.ts` tags each function with the
node-data types — `NodeRecord` / `ServerNodeRow` / `PublicChunk` / `NodeHyperlightView` /
`NodeHyperciteView` — that appear in its signature or body), plus the `store:<table>` object store
and the DOM as waypoints. So you see the data's whole **PG↔IndexedDB↔DOM lineage** at once, laid out
top→bottom by the grid's rows. It deliberately **overrides the `trace:` direction toggle** — a type
trace is the entire journey of that data, not a one-directional walk. (Mechanism: `TABLE_TYPES` +
`collectTypeReferences()` in `collect.ts`; the `types` field on `fn`/`table` nodes; `paintTypeTrace`
in the embedded page. Scope today is `nodes`; extend `TABLE_TYPES` for the other stores.)

> **Known limitation — the backend/pull side is approximate.** The Postgres-table boxes are an
> *abstraction*, not the real seam, and the edges to them are guesses, two ways. (1) **Table
> attribution is hand-coded:** `ENDPOINT_TABLES` maps each endpoint to a fixed list of tables and
> draws one `push`/`pull` edge per table — so a "from `nodes`" arrow only means "`nodes` is in that
> endpoint's hand-written list", *not* that the function received node data (a library-only fetch
> still shows an edge from `pg:nodes`). (2) **Endpoint detection sees only the URL head:** a template
> URL like `` `/api/…/books/${id}/data` `` is captured only up to the first `${}`, so `…/data` and
> `…/annotations` collapse to the same `…/books/` endpoint — the map can't even separate
> book-content loads from annotation loads. The planned fix is an **API/route tier** that keys each
> endpoint to its TS receiver and the response type it's annotated with (`BookDataResponse` /
> `AnnotationsResponse` / `UnifiedSyncPayload`), so each endpoint shows the *specific* data it
> carries and where TS receives it — see "Next" below.

---

## How `js/collect.ts` works

Pure on import (only `writeArtifacts()` touches disk) and deterministic (no `Date`/`Math.random`)
so the no-drift gate can byte-compare. It walks `resources/js/indexedDB/` plus the DOM-facing
`EXTRA_ROOTS` (`hyperlights`, `hypercites`, `divEditor`, `editToolbar`, `footnotes`, `citations`,
`hyperlitContainer`) and, per **top-level
exported function AND class method** (`ClassName.method` — so class-per-file code like
editToolbar is represented, not just function-first modules), uses the **TypeScript compiler
API** (AST, not regex) to detect: stores read/written, API endpoints
(`fetch`/`sendBeacon` → Postgres tables via `ENDPOINT_TABLES`; URLs are matched by the literal head
of template strings, so `appendGateParam(`/api/…/${id}`)` is now seen), DOM touch (incl.
selection/range/treewalker/execCommand APIs), calls, and the **data-record type names** referenced
in each function's signature/body (filtered to `TABLE_TYPES`, e.g. `NodeRecord` — drives the
type-trace lens). It reads
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

Planned, not built. **Step 0 (the immediate next build) is an API/route tier** that replaces the
coarse `ENDPOINT_TABLES` guess (see the limitation note above): each real endpoint becomes a node
keyed to its TS receiver and the **response type it's annotated with** — `…/books/{id}/data` →
`BookDataResponse` (the author's content: nodes/footnotes/bibliography/library + the embedded
annotations), `…/books/{id}/annotations` → `AnnotationsResponse` (just hyperlights/hypercites, the
"load others' metadata separately" path), the upserts → `UnifiedSyncPayload`/per-store records. That
makes each endpoint show the *specific* data it carries, distinguishes book-content from annotation
loads, and is the seam the PHP tiers below join onto. Then, above it:

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
