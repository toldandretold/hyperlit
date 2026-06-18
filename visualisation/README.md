# /visualisation — codebase data-flow map

A map of how data moves through Hyperlit, **generated from the code itself** (nothing is
hand-drawn). Open **`visualisation/generated/full-stack-data-map.html`** in a browser — it's
self-contained and works over `file://`.

The goal is a single, honest picture of the data spine:

```
reader.blade.php → JS (DOM modules) → JS (IndexedDB) → [HTTP route] → Laravel controller → Postgres table
└──────────────── visualisation/js/collect.ts ────────────────┘   └──── visualisation/php/collect.php ────┘
```

**Today** it covers the stack end-to-end: the page, the DOM-manipulation modules
(`hyperlights` / `hypercites` / `divEditor`), the IndexedDB layer, the API route seam, **and the
Laravel controllers** that actually read/write each Postgres table — stitched together at the
shared endpoint URL. The remaining gap is the deeper backend (Eloquent **model** nodes as their own
tier, and controller→service call graphs); see "The PHP/backend tier" below.

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

- **`generated/backend.generated.json`** — the Laravel controller tier (one node per
  `Controller@method` on a data route, with the Postgres tables it touches + the row-shape it
  builds), emitted by `php/collect.php`. `js/collect.ts` reads it and stitches it onto the route nodes.

Caveats: covers the data layer (indexedDB + the 7 DOM/feature folders + the API seam) plus the
backend controllers on those routes, and it's *function-level data flow*, not business logic. It's
only trustworthy because CI byte-checks it — regenerate with `npm run viz:idb` and commit after
changing scanned code (incl. the controllers). (See `Hyperlit/CLAUDE.md` for the standing review gate.)

---

## Layout

```
visualisation/
├── js/
│   └── collect.ts          the front-end generator (TS-AST) + the backend-tier merge (mergeBackendTier)
├── php/
│   └── collect.php         the backend generator (php-parser AST of routes/api.php + Db* controllers)
├── merge.ts                the BackendGraph contract (the join shape collect.php emits to)
├── generated/                  ALL output (self-contained — open the .html directly)
│   ├── full-stack-data-map.html  the interactive cytoscape diagram
│   ├── vendor/cytoscape.min.js   vendored (referenced relatively so file:// stays offline)
│   ├── flowViz.generated.json    the raw {nodes, modules, edges} graph (incl. the merged controller tier)
│   ├── backend.generated.json    the raw backend graph (controllers → tables), from php/collect.php
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
  PostgreSQL tables ▸ **Laravel controllers** ▸ API routes (load/save) ▸ code that bridges
  IndexedDB↔server ▸ IndexedDB stores ▸ code that bridges page↔IndexedDB ▸ `reader.blade.php`.
  The **Laravel controllers** sit between the PG tables and the routes — the PHP methods that
  actually run the SQL, so the map reads truly end-to-end: `DOM ↔ TS ↔ IndexedDB ↔ route ↔
  controller ↔ table`. They follow the **same folder→file model as the TS side**: a dark-red box is
  a **controller class** (one PHP file, e.g. `DbHyperlightController`); **double-click to expand** it
  into its route-handler **methods** (`upsert` / `delete` / `hide`), exactly like drilling a TS module
  into its functions. Collapsed, a class box folds all its methods' table/route edges onto itself.
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
(today: `nodes`, `library`, `footnotes`, `bibliography`) doesn't do the generic edge-trace — it lights
the **functions that actually handle that data type**, read from the TypeScript annotations
(`collect.ts` tags each function with the welded type names that appear in its signature or body —
`nodes`: `NodeRecord`/`ServerNodeRow`/`PublicChunk`/`NodeHyperlightView`/`NodeHyperciteView`;
`library`: `ServerLibraryRow`→`LibraryRecord`; `footnotes`: `ServerFootnotesPayload`→`FootnoteRecord`;
`bibliography`: `ServerBibliographyPayload`→`BibliographyRecord` — the last two are payload-maps the
loader expands per-row), plus the `store:<table>` object store
and the DOM as waypoints. So you see the data's whole **PG↔IndexedDB↔DOM lineage** at once, laid out
top→bottom by the grid's rows. It deliberately **overrides the `trace:` direction toggle** — a type
trace is the entire journey of that data, not a one-directional walk. (Mechanism: `TABLE_TYPES` +
`collectTypeReferences()` in `collect.ts`; the `types` field on `fn`/`table` nodes; `paintTypeTrace`
in the embedded page. Add a table by welding its wire/store types + listing them in `TABLE_TYPES`.)
> *Note:* `library` is the ownership/auth table, so its trace also lights the many backend controllers
> that read it for permission checks — that's a **feature**: it surfaces every ownership/`PgLibrary::where`
> gate across the backend at a glance. The frontend lineage stays crisp; telling an auth-read apart from
> a data read/write *per table* (so the backend side could be filtered) is the deferred per-table
> read/write fidelity item.

With the backend tier built, the `nodes` type-trace now threads the **whole** seam:
`pg:nodes ← controller (getBookData / targetedUpsert / …) ← route ← fn → store:nodes → dom`. The
controllers light up because their node is tagged with the `nodes` types and the trace BFS walks the
push/pull edges through them (without bleeding into the sibling tables a multi-table controller also
touches — see `carryingForTable` in the embedded page).

> **What the backend tier resolved (and what's still approximate).** The Postgres-table boxes used
> to be an abstraction wired to TS by a hand-coded `ENDPOINT_TABLES` guess. That's now largely
> replaced: each route carries a **Laravel controller** node whose tables are **derived** from the
> code — each `Pg*` model's `$table` plus raw `DB::table('…')` / `INSERT INTO …` literals, read by
> `php/collect.php`. So a "from `nodes`" arrow now means a real controller method actually queries
> `nodes`. **Remaining coarseness:** (1) a controller's edges are drawn by its route's HTTP verb
> (GET → read, POST → write), so a write endpoint that *reads* a table for an auth check (e.g. the
> node upsert reads `library`) shows that as a write edge; (2) **cross-controller delegation** isn't
> followed across classes — `unified-sync` delegates to the per-store upserts, so its own tables are
> back-filled from the route's declared list rather than traced into the delegate methods; (3) only
> controllers sitting on a **front-end-detected route** are shown (other real methods exist but
> aren't on the traced data path). See "The PHP/backend tier" below for what's next.

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

## The PHP/backend tier (`php/collect.php`)

**Built.** `php/collect.php` parses `routes/api.php` (tracking `Route::prefix()->group()` nesting +
the `/api` mount, resolving `[Controller::class, 'method']` handlers) and the `Db*` +
`DatabaseToIndexedDB` controllers via [`nikic/php-parser`](https://github.com/nikic/PHP-Parser) —
the PHP-AST analogue of how `js/collect.ts` uses the TS compiler API. Pure static analysis (no
Laravel boot, no DB), so the output byte-checks. For each controller method on a data route it reads:
the **tables** it touches (each `Pg*` model's `$table` + raw `DB::table('…')` / `INSERT INTO …`
literals, following same-class private helpers like `getBookData → getNodeChunks*`), the **direction**
(GET → pull, write verb → push), and the **row-shape** keys it builds. It emits
`generated/backend.generated.json`; `js/collect.ts:mergeBackendTier()` stitches each controller
between its route node and the PG tables. Gated by `tests/Unit/Visualisation/BackendFlowmapTest.php`
(byte-compare, mirrors the JS gate) + the controller pins in `flowViz.generate.test.js`.

**Still to do, deeper into the backend:**

1. **Eloquent `model` nodes** as their own sub-tier between controller and table (the `$table` map is
   already collected) — shows which model mediates each write, and makes `PgNodeChunk` etc. first-class.
2. **Cross-controller + controller→service call graphs** — follow `unified-sync` into the per-store
   upserts and controllers into services (`BookDeletionService`, `SubBookRegistrar`) so delegated
   table touches are traced rather than back-filled from the route's declared list (see limitation #2).
3. **Per-table read/write fidelity** — distinguish a write endpoint's data writes from its incidental
   auth reads (limitation #1), instead of colouring all edges by the route verb.
4. **`Route::getRoutes()` cross-check** — an optional `artisan` pass to confirm the statically-parsed
   route map matches Laravel's live route table (catches routes registered outside `routes/api.php`).
