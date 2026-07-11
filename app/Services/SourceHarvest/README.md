# Source Network Harvester

The Source Network Harvester ("Import Knowledge Network" in a book's creator tools) builds out the legally-pullable citation network from a starting book: it resolves the book's citations to `canonical_source` rows, then fetches and converts every eligible open-access cited work into that canonical's `auto_version_book` — so the book's citations progressively link to real, held, verified source texts instead of external cards.

## What one run does

A run is one row in `source_network_harvests` driven by `SourceNetworkHarvestJob` (queue `citation-pipeline`, single sequential job, `tries=1`) through `HarvestRunner`. The runner pops `{book, depth}` entries off the row's `frontier` queue and, for each: (1) **scan** — `Artisan::call('citation:scan-bibliography', target)` resolves that book's bibliography/footnote entries against OpenAlex → Open Library → Semantic Scholar and writes `bibliography.canonical_source_id` (the command owns the two-pass bibliography+footnote logic; its results land in DB columns, so no rich return value is needed); (2) **select** — `HarvestEligibility::eligibleCanonicalsFor()` picks the reached canonicals that are unharvested, open access, and fetchable, most-cited first, limited to the run's remaining work budget; (3) **harvest** — `CanonicalVersions\AutoVersionCreator::create()` per work: mint/reuse a system stub, run `ContentFetchService::fetch()` (JATS / OA PDF / HTML / browser lanes), OCR the PDF lane, and wire `canonical.auto_version_book`. Each work is wrapped in try/catch — one bad PDF never kills the run; (4) **shelf** — `HarvestShelf` collects the run's imported sources onto the owner's "Harvested from: <Title>" shelf. On finish the runner bumps `library.annotations_updated_at` on the root book so the frontend re-syncs its bibliography records.

These four stage ids (`scan`, `select`, `harvest`, `shelf`) are the telemetry stage vocabulary and the identifiers in `HarvestMap::stages()` — the single source the live-progress visualisation renders from. `HarvestMapDriftTest` (mirroring the citation pipeline's `PipelineMapDriftTest`, which covers its OWN separate map) fails if a map id stops matching a `HarvestTelemetry::emit()` literal in `HarvestRunner`, or if a `code_ref` stops resolving. Add a stage to the runner = add it to the map.

## Live progress visualisation

`GET /api/source-harvest/map` returns `HarvestMap::stages()`; `GET /api/source-harvest/status/{id}` returns the telemetry event stream (same `{stage, status, detail, signals, at}` shape as the citation pipeline). The frontend overlay `harvestViz.ts` (a port of `aiReview/pipelineViz.ts`, opened from a "See live progress" toggle in the running-state row) renders the four-stage chain with sticky per-stage status, an auto-following details panel, and a completion banner carrying the imported count and the shelf link. The overlay id `harvest-viz-overlay` is focus-trapped via `trapModalFocus` (registered in `overlaySurfacesInventory.json`) — unlike the ai-review viz, which still carries deferred trap debt. Fast 5s polling while the overlay is open, 10s otherwise.

## Email me when done

`POST /api/source-harvest/{id}/notify` (authenticated harvest owner only — anonymous owners have no email — 422 once finished, `throttle:10,1`) sets the `notify_email` flag on the harvest row. `SourceNetworkHarvestJob` then sends `HarvestCompleteMail` / `HarvestFailedMail` (blade views modeled on the import emails; the complete mail carries the counts summary, a link to the book, and the shelf link) from its `handle()` / `failed()` paths — best-effort, a mail failure never fails the job. The frontend "Email me when done" button (in the running row, logged-in users only) POSTs the endpoint and swaps to a confirmation.

## The harvest shelf

`HarvestShelf::ensureShelfFor($rootBook)` find-or-creates a shelf named `Harvested from: <root title>` owned by the root book's creator (the harvest is owner-triggered, so book owner == triggering user), `private` by default; `addBooks()` upserts the run's imported books (`assigned` + `assigned_existing`) and flushes the shelf render cache. Re-harvests of the same book resolve the SAME shelf (keyed on `(creator, name)`) and append — the `shelf_items` PK dedupes. Shelves require a named `creator` (the column is NOT NULL) and only exist on a user page, so anonymously-owned books get no shelf and the shelf step is skipped. Slug generation is shared with `ShelfController` via `App\Services\ShelfSlug` so the two can't drift. The harvest row stores `shelf_id`; the status endpoint returns `harvest.shelf = {id, name, slug, creator}` so the completion dialog and email can link to `/u/{creator}/shelf/{slug}`. CAVEAT accepted by design: two different books with the SAME title share one shelf (uniqueness is `(creator, name)`); the shelf description names the source book.

## Eligibility

`HarvestEligibility` is the single source of truth. A canonical is eligible when `auto_version_book IS NULL AND is_oa AND (pdf_url or oa_url or doi present)`. Canonicals are reached from the book two ways: directly via `bibliography.canonical_source_id`, and via `bibliography/footnotes.foundation_source → library.canonical_source_id` (footnotes have no canonical column of their own). The same class provides `estimateFor()` — the pure-SQL numbers behind the confirm dialog. Never use `ContentFetchService::dryFetch()` for estimates: despite the name it performs real downloads.

## Frontier and depth (recursion)

The design is recursion-ready but dormant. Every harvest row carries `max_depth` (config `source_harvest.max_depth`, default 1) and a `frontier` of `{book, depth}` entries seeded with the root at depth 0. When a work is assigned and `depth + 1 < max_depth`, the new auto-version book is pushed onto the frontier and gets ITS bibliography scanned on a later loop iteration — so raising `max_depth` makes the harvester walk the citation network outward with no code change. `visited_books` is the cycle guard. Mind the cost before raising it: each level multiplies OCR spend and each text's bibliography can be 100+ entries.

## The referenced_works closed pool (scan Wave 3.5)

Every harvested text is by construction linked to a canonical with an `openalex_id`, and OpenAlex publishes each work's outbound citations as `referenced_works`. The scan job exploits this: before the open-ended title-search waves, `CitationScanBibliographyJob`'s Wave 3.5 pulls the parent work's referenced-works ids (`WorksApi::fetchReferencedWorkIds`), batch-loads them (`WorksApi::fetchByIdsBatch`, 50-id `ids.openalex` filters), and scores the still-unresolved bibliography entries against that closed candidate pool with the normal `metadataScore` gates. Cheaper and more precise than open search — exactly what a noisy OCR'd bibliography needs — and entries the pool misses fall through to the existing waves unchanged. Books without an OpenAlex identity skip the wave entirely.

## Budget and idempotency

`max_works` (config `source_harvest.max_works_per_run`, snapshotted onto the row at trigger time) is a hard cap per run; most-cited works are harvested first and the overflow is recorded in `counts.capped`. Re-running after a cap, crash, or failure is cheap and safe: eligibility excludes canonicals whose pointer is already set, `AutoVersionCreator` wires pointers from previous partial runs without fetching (assign-first), `SystemVersionMinter::findExistingSystemRow` reuses stubs, and the scan job skips already-linked entries.

## HTTP seam and authorization

`SourceHarvestController`: `POST /api/library/{book}/harvest/estimate` (owner, pure SQL), `POST /api/library/{book}/harvest/trigger` (owner + `BillingService::canProceed` + `EncryptedBookGuard` 422 + cache-lock, 409 while a harvest OR a citation pipeline is active for the book), `GET /api/source-harvest/status/{id}` and `GET /api/source-harvest/running/{book}` (polls, with the stale watchdog: pending > 5 min or running > 3 h auto-fails). The job writes everything through `pgsql_admin`, so the controller's `ResolvesBookOwner` check is THE authorization boundary — mirror `SourceVerificationController`, not `CitationScannerController` (which has no owner gate).

## Why not citation_pipelines

Harvest state deliberately lives in its own `source_network_harvests` table with its own `HarvestTelemetry` (a clone of `PipelineTelemetry`'s capped read-append-write stream). The citation pipeline's `PipelineMap` + `PipelineMapDriftTest` contract hard-codes its four-stage chain, and a harvest has a different lifecycle (frontier, depth, work budget). Do not merge them.

## Frontend

`resources/js/components/sourceContainer/creatorTools/harvestNetwork.ts` renders the button, runs estimate → `confirmDialog` → trigger, polls status every 10s (button text mirrors `step_detail`), and calls `refreshCitationDisplay()` on completion. No changes to `displayCitations/` were needed: matched references already resolve through `/api/canonical/{id}/best-version`, which prefers held versions including `auto_version_book`.

## Tests

`tests/Feature/Api/SourceHarvestLifecycleTest.php` (owner gate, estimate math, trigger concurrency, encrypted 422, stale auto-fail, poll contracts) and `tests/Canonical/AutoVersionCreatorTest.php` (the per-work no-network paths, including the `pdf_url_status` re-fetch-skip guard).
