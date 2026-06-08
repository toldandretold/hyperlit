# API restructure findings register

A ranked backlog of consistency / concurrency / structural issues in the HTTP
API, surfaced while building the endpoint test suite (`tests/Feature/Api/`).

**This file changes no behaviour.** The tests pin *current* behaviour
(characterization tests); the items here are candidates for a *separate*, later
refactor that the tests will make safe. When a test documents one of these, it
links back here in a comment so the gap is visible at the call site.

Status legend: 🔴 real bug / data-race · 🟠 inconsistency / footgun · 🟡 cosmetic.
✅ FIXED markers note items already resolved (with the commit/PR that did it).

**Fixed so far:** F1, F2, F4 (job-dispatch guards) and F10 (validation masked as
500) — see the ✅ notes inline. Remaining: F3, F5–F9, F11, and **F12** (🔴 cache
stampede rebuilding shared homepage/shelf node rows — confirmed real, the most
likely *multi-user* bug; not yet fixed).

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

### F12 🔴 Cache stampede → concurrent rebuild of SHARED node rows
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
- **Reproduce with:** `tests/load/loadprobe.php` — clear the synthetic rebuild
  rows on the server's DB (cold cache) then burst ~15 concurrent; a non-zero 5xx
  column (0 at concurrency 1) confirms it. Recipe in `tests/load/README.md`.
- **Note on rate limiting:** the per-IP `throttle:60,1` does NOT mitigate this —
  it's per-IP, and the stampede fires at ~10–25 concurrent (under one budget),
  driven by *distinct* users, not a single hammering client.

### F8 🟠 `UnifiedSyncController::sync` wraps child controllers in nested transactions
`sync()` opens a transaction and calls `DbNodeChunkController` etc., each of which
opens its own transaction. Nested savepoints can let a child "succeed" while the
outer intent fails. Candidate for extraction into a service with one transaction
boundary.

### F9 🟡 No API versioning / resource layer
All routes are a flat `/api/...` namespace; models are serialized directly with no
`Http/Resources` transformers, so field exposure (timestamps, `creator_token`,
`raw_json`) is inconsistent. Out of scope for now; noted for completeness.

---

## How to add a finding
When a test surfaces something, append an `F<n>` entry here (with the failing/
documented behaviour and a fix candidate) and add a one-line `// see
docs/api-restructure-findings.md#f<n>` comment at the test.
