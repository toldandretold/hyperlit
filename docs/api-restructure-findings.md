# API restructure findings register

A ranked backlog of consistency / concurrency / structural issues in the HTTP
API, surfaced while building the endpoint test suite (`tests/Feature/Api/`).

**This file changes no behaviour.** The tests pin *current* behaviour
(characterization tests); the items here are candidates for a *separate*, later
refactor that the tests will make safe. When a test documents one of these, it
links back here in a comment so the gap is visible at the call site.

Status legend: 🔴 real bug / data-race · 🟠 inconsistency / footgun · 🟡 cosmetic.
✅ FIXED markers note items already resolved (with the commit/PR that did it).

**Fixed so far:** F1, F2, F4 (job-dispatch guards), F8 (sync atomicity / mixed
connections), F10 (validation masked as 500), and **F12** (🔴 cache stampede on
shared homepage/shelf node rows). **F5/F6/F7 standard established** (see below) with
one endpoint migrated as the worked example; the rest is incremental. Remaining:
F3, F9, F11, and the F5/F6/F7 per-endpoint migration tail.

**F5/F6/F7 — response-consistency sweep (◐ IN PROGRESS, standard set):**
The frontend survey (`docs/api-conventions.md`) showed there's already a de-facto
envelope the SPA expects — `{success, <named payload>, message, errors}` + correct
HTTP status — and that a generic `data` wrapper would BREAK it. So the sweep is
"conform deviators to the existing shape," not "introduce a new one."
- **Standard:** `App\Http\Responses\ApiResponse` (ok/error/validationError) +
  `docs/api-conventions.md`.
- **Migrated: the ENTIRE `db/*` write group** (everything the editor saves +
  the sync orchestrator drives):
  - `DbLibraryController::upsert`
  - `DbHyperciteController::upsert`
  - `DbHyperlightController::upsert` + `bulkCreate` + `delete` + `hide`
  - `DbFootnoteController::upsert`
  - `DbReferencesController::upsertReferences`
  - `DbNodeChunkController` (upsert / bulkCreate / targetedUpsert validation paths)

  All validation failures now return the standard **422** `{success, message[, errors]}`
  (were bare 400 / bare `{errors}` / Laravel's `{message,errors}`). Tests flipped;
  full Api suite green (187); `SyncApiTest` confirms the dual-entry orchestrator
  path still works through every one.
- **Two learnings baked into `api-conventions.md`:** (1) no central fetch wrapper →
  the SPA branches on HTTP status first, so codes matter most; (2) the `db/*`
  endpoints are **dual-entry** (HTTP + `UnifiedSyncController`), so they use an
  inline `Validator`, NOT a Form Request (a Form Request type-hint TypeErrors when
  the orchestrator passes a plain `Request`).
- **Verification caveat:** the Playwright broad-net smoke is currently
  *environmentally* blocked — `page.goto` hangs on the SPA `load` event in a fresh
  browser (the `public/sw.js` service worker, a documented project gotcha),
  unrelated to any API change. So migrations are verified per-endpoint via the Pest
  contract + reading the specific `resources/js` consumer (which for these
  background-sync endpoints key off `res.ok`, making 400→422 transparent). Fixing
  the E2E SW/Playwright boot is its own task.
- **Remaining:** the `{error,reason}` shapes (`RequireAuthor` middleware) and the
  read-endpoint tail (search/billing/shelf/etc.) — same mechanical recipe each,
  lower-traffic than the write group just completed.

---

## Concurrency & idempotency

### F1 🔴 ✅ FIXED — Job-dispatch endpoints had no uniqueness guard
Two near-simultaneous requests to the same book used to dispatch two jobs racing
on the same filesystem dir and DB rows (e.g. a double-clicked "Convert").
- **Fix:** a per-book `Cache::lock` (prod cache = `database`, supports locks):
  - `reconvert` — short atomic lock around the check + a fresh `progress.json`
    in-flight marker (status `queued`/`processing`, 30-min staleness cap). A
    concurrent re-trigger now gets **409**.
  - `vibe-convert/start` — lock held for the whole run (TTL = 1800s ≥ Process
    timeout); `VibeConversionJob` releases it on completion / via `failed()`; the
    TTL is the crash backstop so a book is never permanently blocked. → **409**.
- **Still open:** `POST /import-file` (fresh import) — same pattern applies but the
  800-line `store()` wasn't touched yet; lower risk (fresh import mints a new book
  id). Apply the reconvert guard when that method is next edited.
- **Covered by:** `ImportApiTest` ("…blocks a concurrent re-trigger (F1/F4 fixed)")
  and `VibeConvertApiTest` ("…blocks a concurrent start (F1 fixed)") — now assert
  the 2nd request → 409 and only ONE job queued.

### F2 🔴 ✅ FIXED — TOCTOU on the "already running" checks
`CitationScannerController::scan` and `::triggerPipeline` did
`whereIn('status',['pending','running'])->first()` then `insert()` with nothing
between, so two concurrent requests could both pass the check and both insert.
- **Fix:** wrapped each check-and-insert in an atomic per-book `Cache::lock`
  (`citation-scan:{book}` / `citation-pipeline:{book}`), released in a `finally`.
- **Covered by:** `CitationApiTest` (sequential 409 + one row). True-parallel
  verification is the Phase 4 live harness (`tests/Feature/Api/Concurrency/`).

### F3 🟠 File-based progress markers are clobbered by concurrent runs
Progress is plain files (`markdown/{book}/progress.json`, `vibe_progress.json`,
`vibe_cancel`). Concurrent imports/vibe runs for one book overwrite each other's
markers; the shutdown handler in `ProcessDocumentImportJob` writes without
locking. Cancel is signalled by a sentinel file, not a DB flag.
- **Fix candidates:** move progress/cancel to a DB row (also fixes polling under
  multiple app servers).

### F4 🟠 ◐ PARTLY FIXED — `reconvert` / `vibe-convert/accept` in-flight guard
`reconvert` is now guarded (see F1). `POST /api/vibe-convert/accept` still applies
a patch with no lock — two concurrent accepts could race to swap nodes. Lower
impact (it's a deliberate user action on a reviewed result, not a double-click),
but worth the same per-book lock. **Still open: vibe-convert/accept.**

---

## Response & validation consistency

### F5 🟠 No standard JSON response envelope
Shapes vary across controllers: `{success, message}`, `{error, reason}`, bare
`{message}`, and Laravel's `{message, errors}`. The SPA branches on status codes,
which is why the tests assert status (see `InteractsWithApi::assertApiError`)
rather than body shape.
- **Fix candidates:** an `ApiResponse`/`Responsable` helper for `{ok, data, error}`.

### F6 🟠 Status codes for the same condition differ across endpoints
e.g. invalid input is sometimes `400`, sometimes `422`; auth failures span
`401/402/403`. Worth a documented convention before standardising.

### F7 🟡 Validation is mostly inline `$request->validate()`
Only ~8 Form Request classes exist for ~45 controllers
(`app/Http/Requests/LibraryUpsertRequest.php`, `HyperlightRequest.php`, …). Inline
validation is fine but the error-shape inconsistency (F5/F6) partly stems from it.

---

## Structure

### F10 🟠 ✅ FIXED — Annotation upserts masked client errors as HTTP 500
In `Db{Hyperlight,Hypercite,Footnote}Controller`, input handling sits inside a
`try { … } catch (\Exception)` that returns 500:
- **Footnotes** `upsert` runs `$request->validate(...)` *inside* the try, so the
  `ValidationException` is caught and returned as **500** — Laravel's 422
  `{message, errors}` (which the SPA could surface to the user) is lost.
- **Hyperlights/Hypercites** `upsert` log `count($data['data'])` before the
  `is_array` guard; a non-array `data` raises a `TypeError` → **500**. Omitting
  `data` entirely reaches the intended `400 {success:false,'Invalid data format'}`.
- **Fix:** moved footnotes' `validate()` OUT of the try/catch (ValidationException
  now surfaces as a proper **422** with field errors); guarded the
  `count($data['data'])` log lines with `is_array(...)` so a non-array `data`
  reaches the intended **400** instead of TypeError-ing into a 500.
- **Covered by:** `AnnotationsApiTest` — now asserts 422 (footnotes) / 400
  (hyperlights, hypercites) on bad input. *(Note: the broader `{success,message}`
  vs `{message,errors}` envelope inconsistency is still F5/F6.)*

### F11 🟡 Unvalidated UUID route params 500 instead of 404
Routes like `/api/shelves/{id}` read `…->where('id', $id)` with no constraint on
`{id}`. A non-UUID segment (e.g. `/api/shelves/99999999`) reaches Postgres as an
invalid uuid and raises a `QueryException` → **500**, where a `404` (or `422`) is
expected. **Fix candidates:** a `whereUuid` route constraint, or validate/guard
the param before the query. **Covered by:** `ShelfApiTest` (note on the not-found
tests; they use a real UUID to reach the intended 404).

### F12 🔴 ✅ FIXED — Cache stampede → concurrent rebuild of SHARED node rows
The two server-rendered "synthetic book" surfaces regenerate shared `nodes` rows
with a non-atomic `DELETE`+`INSERT` guarded only by a best-effort cache check, so a
burst of concurrent requests on a cold/expired cache all rebuild at once and
collide. Unlike F1/F2 (per-book, one owner), these rows are **shared across many
users**, so ordinary multi-user traffic triggers it.

- **Homepage (highest traffic):** `HomePageServerController::getHomePageBooks`
  uses `Cache::remember(CACHE_KEY, 900, fn => generateHomePageBooks())`
  (HomePageServerController.php:43). `Cache::remember` is **not** stampede-safe —
  when the 15-min TTL lapses, every concurrent homepage load misses and calls
  `generateHomePageBooks()`, which `DELETE`s then re-`INSERT`s the GLOBAL
  `most-recent`/`most-connected`/`most-lit` node rows (lines 114–126). Concurrent
  inserts violate `nodes_book_startline_unique (book, startLine)` /
  `nodes_book_node_id_unique (book, node_id)` → **500s** for the losers, and
  interleaved deletes can leave a half-built homepage for a beat.
- **Public shelf render:** `ShelfController::render` / `publicRender` do the same
  `DELETE`+`INSERT` on `shelf_{id}_{sort}[_pub]` (ShelfController.php:435–438,
  530–533), gated by an "already rendered?" `exists()` check (lines 354, 462) that
  only protects once warm. Cold cache (first view, or after `ShelfCacheInvalidator`
  clears it on a shelf edit) + concurrent viewers → same collision. `publicRender`
  is unauthenticated, so the herd is unbounded.

- **Symptom:** transient HTTP 500 (unique violation) on cache-cold bursts +
  momentary partial renders. Self-heals on retry once one rebuild wins and warms
  the cache — so it reads as "the homepage/shelf occasionally 500s under load."
- **Fix candidates:** a single-flight mutex around each rebuild — `Cache::lock`
  with double-checked caching: acquire → re-check the cache → rebuild only if still
  cold → release; concurrent callers `block()` briefly then read the now-warm
  result. (Same lock primitive as the F1/F2 fix.) Alternatively build into a fresh
  table and swap, or `INSERT … ON CONFLICT DO NOTHING`. The homepage is the urgent
  one (traffic × predictable 15-min expiry).
- **Fix:** a single-flight `Cache::lock` around each rebuild (same primitive as
  F1/F2). Homepage: `getHomePageBooks` serves cache fast-path, else acquires
  `homepage_books:rebuild` and rebuilds once under the lock (others block ≤10s then
  read the warm cache); `updateHomePageBooks` takes the same lock.
  HomePageServerController.php:41–86. Shelf: `render`/`publicRender` route the
  node DELETE+INSERT through `writeRenderNodes()`, which locks
  `shelf-render:{syntheticBookId}` + double-checks before writing.
  ShelfController.php:338–369.
- **Verify with:** `tests/load/loadprobe.php` — clear the synthetic rebuild rows on
  the server's DB (cold cache) then burst ~15 concurrent. Pre-fix: a non-zero 5xx
  column (0 at concurrency 1). Post-fix: all 2xx. Recipe in `tests/load/README.md`.
- **Note on rate limiting:** the per-IP `throttle:60,1` does NOT mitigate this —
  it's per-IP, and the stampede fires at ~10–25 concurrent (under one budget),
  driven by *distinct* users. Use `loadprobe.php --ip-spread` to simulate distinct
  users from one machine (the app trusts `X-Forwarded-For`).

### F8 🟠 ✅ FIXED — `UnifiedSyncController::sync` atomicity gap (mixed connections)
On closer inspection the documented "nested savepoints" worry was mostly benign —
only `DbLibraryController::upsert` opens its own `DB::transaction`, and that's a
savepoint on the SAME (default) connection, so it rolls back with the outer. The
REAL gap: two deletion steps cleaned up via the **`pgsql_admin` connection**
(`DbHyperlightController::delete` → sub-book content + hypercite delinking;
`DbFootnoteController::delink`). That connection is NOT part of the sync's
`DB::transaction`, so those writes committed immediately — if a *later* sync step
then rolled the (default-connection) transaction back, the admin-connection cleanup
was already gone → orphaned sub-book content / delinked hypercites.
- **Fix:** moved `hyperlightDeletions` + `footnoteDeletions` out of the transaction
  into `applyHyperlightDeletions()` / `applyFootnoteDeletions()`, called **after**
  the upsert transaction commits. So the admin-connection cleanup only runs once the
  upserts have durably landed; a rolled-back sync can no longer orphan anything.
  (No ordering risk: `library` upsert takes counts from the payload, not a recount.)
  UnifiedSyncController.php.
- **Behaviour note:** a deletion failure now 500s with the upserts already
  committed (vs. previously rolling everything back). That's the safer trade — the
  client retries the whole sync and the upserts are idempotent.
- **Covered by:** `SyncApiTest` happy-path (transaction + child upsert + post-commit
  deletion helpers + envelope).

### F9 🟡 No API versioning / resource layer
All routes are a flat `/api/...` namespace; models are serialized directly with no
`Http/Resources` transformers, so field exposure (timestamps, `creator_token`,
`raw_json`) is inconsistent. Out of scope for now; noted for completeness.

---

## How to add a finding
When a test surfaces something, append an `F<n>` entry here (with the failing/
documented behaviour and a fix candidate) and add a one-line `// see
docs/api-restructure-findings.md#f<n>` comment at the test.
