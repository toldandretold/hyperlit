# API restructure findings register

A ranked backlog of consistency / concurrency / structural issues in the HTTP
API, surfaced while building the endpoint test suite (`tests/Feature/Api/`).

**This file changes no behaviour.** The tests pin *current* behaviour
(characterization tests); the items here are candidates for a *separate*, later
refactor that the tests will make safe. When a test documents one of these, it
links back here in a comment so the gap is visible at the call site.

Status legend: 🔴 real bug / data-race · 🟠 inconsistency / footgun · 🟡 cosmetic.

---

## Concurrency & idempotency

### F1 🔴 Job-dispatch endpoints have no uniqueness guard
`ProcessDocumentImportJob`, `VibeConversionJob`, and `CitationScanBibliographyJob`
do not implement `ShouldBeUnique` and acquire no lock. Two near-simultaneous
requests to the same book dispatch two jobs that race on the same filesystem
working dir and DB rows.
- **Endpoints:** `POST /import-file`, `POST /api/books/{book}/reconvert`,
  `POST /api/vibe-convert/start`, `POST /api/citation-scanner/scan`.
- **Fix candidates:** `ShouldBeUnique` keyed on book id; or an advisory lock /
  `lockForUpdate` around the "is one already running?" check.
- **Covered by:** `VibeConvertApiTest` ("…NO in-flight guard — two starts queue
  two jobs") and `ImportApiTest` ("…NO in-flight guard — two calls queue two
  jobs") — both currently assert the GAP (2 jobs). Flip to 1 + a 409 when fixed.

### F2 🔴 TOCTOU on the "already running" checks
`CitationScannerController::scan` and `::triggerPipeline` do
`whereIn('status',['pending','running'])->first()` then `insert()` with no
transaction/lock between. Two concurrent requests can both see "none running"
and both insert. The guard is real but not atomic.
- **Fix candidates:** unique partial index on `(book) where status in
  ('pending','running')`, or `SELECT ... FOR UPDATE` inside a transaction.
- **Covered by:** `CitationApiTest` proves the guard SEQUENTIALLY (2nd call →
  409). The TOCTOU race itself is only reproducible under true concurrency — see
  the Phase 4 live harness (`tests/Feature/Api/Concurrency/`).

### F3 🟠 File-based progress markers are clobbered by concurrent runs
Progress is plain files (`markdown/{book}/progress.json`, `vibe_progress.json`,
`vibe_cancel`). Concurrent imports/vibe runs for one book overwrite each other's
markers; the shutdown handler in `ProcessDocumentImportJob` writes without
locking. Cancel is signalled by a sentinel file, not a DB flag.
- **Fix candidates:** move progress/cancel to a DB row (also fixes polling under
  multiple app servers).

### F4 🟠 `reconvert` / `vibe-convert/accept` have no in-flight guard
`POST /api/books/{book}/reconvert` dispatches without checking for a running
import. `POST /api/vibe-convert/accept` applies a patch with no lock — two
concurrent accepts race to swap nodes. (Contrast `citation-scanner/scan`, which
at least checks.)

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

### F10 🟠 Annotation upserts mask client errors as HTTP 500
In `Db{Hyperlight,Hypercite,Footnote}Controller`, input handling sits inside a
`try { … } catch (\Exception)` that returns 500:
- **Footnotes** `upsert` runs `$request->validate(...)` *inside* the try, so the
  `ValidationException` is caught and returned as **500** — Laravel's 422
  `{message, errors}` (which the SPA could surface to the user) is lost.
- **Hyperlights/Hypercites** `upsert` log `count($data['data'])` before the
  `is_array` guard; a non-array `data` raises a `TypeError` → **500**. Omitting
  `data` entirely reaches the intended `400 {success:false,'Invalid data format'}`.
- **Fix candidates:** validate via a FormRequest (outside the try), or
  `catch (ValidationException)` first and rethrow; guard `count()` with `is_array`.
- **Covered by:** `AnnotationsApiTest` pins today's 400/500 split.

### F11 🟡 Unvalidated UUID route params 500 instead of 404
Routes like `/api/shelves/{id}` read `…->where('id', $id)` with no constraint on
`{id}`. A non-UUID segment (e.g. `/api/shelves/99999999`) reaches Postgres as an
invalid uuid and raises a `QueryException` → **500**, where a `404` (or `422`) is
expected. **Fix candidates:** a `whereUuid` route constraint, or validate/guard
the param before the query. **Covered by:** `ShelfApiTest` (note on the not-found
tests; they use a real UUID to reach the intended 404).

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
