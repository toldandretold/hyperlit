# Canonical Versions — privileged-version authorities

How Hyperlit decides which `library` row is the *trusted* copy of a work. The
data model (canonical identity vs. uploaded version, the two scores, matching)
is documented in `docs/canonical-sources.md` — this module is the **authority
layer on top of it**: one resolver per privileged-version pointer on
`canonical_source`, plus the single source of precedence between them.

## The four authorities

| Pointer | Resolver | Status | Meaning |
|---|---|---|---|
| `author_version_book` | `AuthorVersionResolver` | ⏳ awaiting ORCID OAuth | Version approved by the verified author |
| `publisher_version_book` | `PublisherVersionResolver` | ⏳ awaiting publisher verification flow | Version published/approved by the verified rights-holder |
| `commons_version_book` | `CommonsVersionResolver` | ⏳ awaiting commoner score + engagement signals | Version most endorsed by the digital commons |
| `auto_version_book` | `AutoVersionResolver` | ✅ **active** | System-generated version: canonical's `pdf_url` vacuumed + Mistral-OCR'd. Known-genuine ("auto-raw"), formatting unwarranted |

Precedence (highest first): **author → publisher → commons → auto**, then any
visible linked version. Identity-verified humans outrank community consensus,
which outranks the untampered machine copy.

Each dormant resolver's class docblock carries the intended algorithm and the
exact dependency it awaits — implementing one should never require touching a
consumer.

## Single-source rules

- **Precedence order** lives in `VersionPointerRegistry::RESOLVERS` only.
- Raw SQL that ranks versions must build its COALESCE via
  `BestVersionService::sqlCoalesceExpression($alias)` (used by
  `SearchService::searchForCitations`). A test asserts `SearchService` contains
  no hard-coded pointer column names.
- User-facing resolution ("which version may *this caller* see") goes through
  `BestVersionService::bestVisibleVersion()` (used by
  `CanonicalSourceController::bestVersion`, i.e. `GET
  /api/canonical/{id}/best-version`).
- Automated pointer assignment goes through
  `VersionPointerRegistry::syncAll($canonical)` (or a single resolver's
  `assign()`). `assign()` never overwrites an already-set pointer unless
  `force: true` — manual/admin assignments survive automated sweeps.

## Visibility rule (decided 2026-06-11)

`library.listed` only governs **homepage listings**, not access. Auto versions
are deliberately created `public + listed=false` so they don't spam listings —
best-version resolution therefore accepts **any non-deleted public row**
regardless of `listed`. Private rows still only resolve for their owner
(creator / creator_token match). Don't reintroduce a `listed` check here; it
made every auto version invisible to anonymous callers.

---

# Ops guide (prod runbook)

## The pipeline at a glance

```
citation scan (CitationScanBibliographyJob)
                              →  identifier-backed resolutions (OpenAlex / DOI /
                                 Open Library / Semantic Scholar) now ALSO create
                                 the canonical and link stub + bibliography
                                 (canonical_source_id). web_fetch / brave_search
                                 stubs never get canonicals (no external identity).
citation pipeline vacuum+OCR  →  after nodes land on a canonical-linked row,
                                 ContentFetchService runs syncAll() — the
                                 canonical gets its auto_version_book with no
                                 manual step.
library:canonicalize          →  links library rows to canonical_source
                                 (and creates canonicals from OpenAlex /
                                  Open Library / Semantic Scholar)
library:create-auto-versions  →  for canonicals with a pdf_url and no
                                 auto_version_book:
                                   1. create provenance-stamped stub library row
                                      (creator=canonicalizer_v1,
                                       conversion_method=pdf_ocr_auto_raw,
                                       public, unlisted)
                                   2. citation:vacuum  — download the PDF
                                   3. citation:ocr     — Mistral OCR → nodes
                                   4. AutoVersionResolver::assign() — wire the
                                      pointer ONLY once has_nodes=true
GET /api/canonical/{id}/best-version  →  resolves to the best visible version
```

## Source acquisition → app-native citations (ContentFetchService::fetch ladder)

A citation source's content is acquired by the first strategy that succeeds,
then converted to the app's native dynamic citations/footnotes. THREE
conversion lanes converge on one persist (`persistArticle`):

```
Strategy 0  JATS XML by DOI ........ JatsFullText: PMC OA fullTextXML → exact
                                     in-text-citation links + bib-entries + <fn>
                                     footnotes (no fuzzy linking). → persistArticle
                                     conversion_method=jats_fulltext
Strategy 1-3 oa_url / pdf_url ....... direct PDF download → citation:ocr (OCR lane)
Strategy 4  Semantic Scholar OA pdf  (repository copies OpenAlex/Unpaywall miss)
Strategy 5  Crossref TDM pdf links
Strategy 6  DOI landing as HTML
Strategy 7  Playwright PDF (fetch-pdf.mjs) — walled-publisher PDFs
Strategy 8  Playwright HTML page (fetch-html.mjs) → PASTE ENGINE
                                     (scripts/paste-convert.mjs, the front-end
                                     journal-HTML processors run on the backend)
                                     → AUTHENTICITY GATE → persistArticle
                                     conversion_method=paste_engine_html (verified)
                                     or html_scrape_unverified (NOT canonical-eligible)
```

**The authenticity gate (`assessArticleAuthenticity`)** is what keeps junk out
of canonical: identity (page citation_doi/citation_title vs the stub, title
similarity ≥ 0.7) × completeness (a real publisher processor matched, refs > 0)
→ `reject` (don't import) / `unverified` (import, never canonical) / `verified`
(canonical-eligible). PDF-OCR, JATS, and verified paste-HTML are the three
`AutoVersionResolver::SYSTEM_CONVERSION_METHODS`; `html_scrape_unverified` is
deliberately excluded.

Routing principle: **documents** (EPUB/PDF/uploads) → `process_document.py`;
**journal HTML** (Strategy 8) → the shared paste JS engine; **JATS XML** →
`JatsFullText` direct emission. All land app-native via `persistArticle`.

Proven live: a Cloudflare-walled non-PMC MIT Press article (`citation:vacuum`
fell through 0–7, Strategy 8 → 344 nodes / 133 refs / 11 footnotes, verified);
a PMC OA article via JATS (40 nodes / 10 refs, in-text citations linked).

## Commands

### `library:canonicalize` — link library rows to canonicals

```bash
php artisan library:canonicalize --missing-only          # backfill unlinked rows
php artisan library:canonicalize --book=<id> -v          # one row, verbose
php artisan library:canonicalize --dry-run --limit=10
php artisan library:canonicalize --force --limit=N       # re-match linked rows
```

Queue wrapper: `CanonicalizeLibraryJob`. Full matching semantics in
`docs/canonical-sources.md`.

### `library:backfill-bib-canonicals` — propagate links to old bibliography entries

```bash
php artisan library:backfill-bib-canonicals --dry-run
php artisan library:backfill-bib-canonicals               # all books
php artisan library:backfill-bib-canonicals --book=<id>   # one book
```

Bibliography entries resolved BEFORE scan-time canonical linking shipped
inherit `canonical_source_id` from their `foundation_source` library row.
Idempotent, never overwrites an existing link. **Run it after every
`library:canonicalize --missing-only` sweep** to propagate fresh links.
Recommended prod order:

```bash
php artisan library:canonicalize --missing-only     # link library rows
php artisan library:backfill-bib-canonicals         # propagate to bibliography
php artisan library:create-auto-versions --dry-run  # then batch auto versions
```

### `library:create-auto-versions` — create the genuine machine versions

```bash
php artisan library:create-auto-versions --dry-run --limit=10   # ALWAYS dry-run first
php artisan library:create-auto-versions --canonical=<id>       # one canonical
php artisan library:create-auto-versions --limit=5              # small batch
php artisan library:create-auto-versions --skip-ocr --limit=20  # vacuum only, OCR later
```

Behavior you can rely on:

- **Idempotent.** Failed runs leave the stub in place; re-running reuses it.
  If an OCR'd stub already exists, the pointer is wired with **zero network
  calls** (the resolver short-circuits before vacuum).
- **`--skip-ocr` defers the pointer.** A vacuumed-but-unOCR'd stub is not a
  version; the canonical stays eligible and a later run completes OCR + wires
  the pointer. (Pre-2026-06-11 this set the pointer on a contentless stub,
  permanently excluding the canonical from sweeps — fixed.)
- **Failure stats:** `vacuum_failed` (download problem — check
  `library.pdf_url_status` for the reason), `ocr_failed` (check
  `storage/logs/laravel.log` for "Mistral OCR" / "processLocalPdf"),
  `deferred` (OCR skipped, pointer intentionally not set).
- **Retry a single failure:** `php artisan citation:ocr <stubBookId>` — the
  OCR response is cached on disk (`resources/markdown/<book>/ocr_response.json`),
  so retries after a save-side failure cost nothing. Then re-run
  `library:create-auto-versions --canonical=<id>` to wire the pointer.

### Costs & cautions for batch runs

- Each NEW canonical costs one PDF download + one **Mistral OCR call**
  (≈ $1 / 1000 pages). arXiv papers are cheap; watch for huge scans —
  e.g. *Origin of Species* (biodiversitylibrary.org, first in the current
  queue) is a full scanned book.
- Start with `--limit=5`, read the summary stats, scale up.
- `--sleep=N` (default 2s) throttles between canonicals.
- Books vs papers: there is currently **no size guard** — if a batch stalls on
  a giant PDF, ctrl-C is safe (idempotent re-run).

## Verifying state (tinker / SQL)

```php
// How many canonicals have auto versions vs. could have them?
$db = DB::connection('pgsql_admin');
$db->table('canonical_source')->whereNotNull('auto_version_book')->count();
$db->table('canonical_source')->whereNotNull('pdf_url')->whereNull('auto_version_book')->count();

// Pointer ↔ stub consistency (every pointer should join to an OCR'd row)
$db->table('canonical_source as c')
   ->join('library as l', 'l.book', '=', 'c.auto_version_book')
   ->whereNotNull('c.auto_version_book')
   ->get(['c.title', 'l.book', 'l.has_nodes', 'l.visibility', 'l.conversion_method']);

// Resolve like an anonymous caller would
app(\App\Services\CanonicalVersions\BestVersionService::class)
    ->bestVisibleVersion(\App\Models\CanonicalSource::find($id), null, null);
```

Or over HTTP: `GET /api/canonical/{id}/best-version` →
`{ book, has_version, metadata }`.

## Known failure mode (fixed 2026-06-11, keep in mind on prod)

The conversion pipeline emits **`nodes.jsonl` / `footnotes.jsonl`** (streamed);
`nodes.json` is a renumbered artifact the *saver* writes afterwards.
`ContentFetchService` used to wait for `nodes.json` → every citation OCR run
"timed out" AFTER a successful conversion (this is why prod likely has ~1 auto
version). The fix is in `ContentFetchService::processLocalPdf` /
`saveNodesToDatabase` / `saveFootnotesToDatabase`; regression-guarded by
`tests/Canonical/CitationOcrSavePathTest.php`. **Symptom if it regresses:**
`ocr_failed` with reason "Timed out waiting for nodes.jsonl" while
`resources/markdown/<book>/` contains a complete conversion.

---

## Adding a new authority

1. Create `<Name>VersionResolver extends BasePointerResolver` — implement
   `pointerColumn()`, `status()`, `resolve()` (and `awaiting()` while dormant).
2. Insert the class in `VersionPointerRegistry::RESOLVERS` at its precedence
   position.
3. Add a migration for the pointer column on `canonical_source` if new.
4. The registry test (`tests/Canonical/VersionPointerRegistryTest.php`) pins
   the expected order — update it deliberately.

Everything else (best-version endpoint, search SQL, syncAll sweeps) picks the
new authority up from the registry.

## Prod deploy note (Strategies 7–8 + paste engine)

The Playwright lanes need their runtime installed on the server:

```
npm install                       # picks up the `playwright` dep (not just @playwright/test)
npx playwright install chromium   # the browser binary fetch-pdf.mjs / fetch-html.mjs drive
```

The paste-engine lane (`scripts/paste-convert.mjs`) needs `happy-dom` (already
a dep). If Playwright is absent, Strategies 7–8 fail gracefully (the cheaper
strategies still run). Restart the queue worker after deploy so pipeline-driven
vacuums pick up the new code.

## Tests

Dedicated suite: `php artisan test --testsuite=Canonical` (`tests/Canonical/`).
Covers: registry precedence + SQL anti-drift, AutoVersionResolver eligibility
and assign semantics, BestVersionService visibility (incl. public-unlisted),
the create-auto-versions no-network paths, the OCR jsonl save contract, and the
paste-engine import gate + persist (`PasteEngineImportTest`). JATS parser:
`tests/Unit/Services/JatsFullTextTest.php`. Paste engine backend parity:
`tests/paste/handlers/backend-entry.test.js`. Endpoint contract:
`tests/Feature/Citations/CanonicalBestVersionTest.php`.

## Roadmap (phases agreed June 2026)

1. ✅ **This module** — modular, testable authority layer; auto authority live
   and verified end-to-end (3 auto versions on dev: Darwin Core + 2 arXiv).
2. ✅ **Citation scan → canonical layer** (shipped 2026-06-11):
   `CitationScanBibliographyJob::linkStubToCanonical` registers identifier-backed
   stubs via the matcher's idempotent upsert and writes
   `bibliography.canonical_source_id` (local_doi/library waves copy the matched
   row's existing link through; footnote-sourced citations reach the canonical
   via their foundation row — the footnotes table has no canonical column).
   `ContentFetchService` stamps OCR'd rows `conversion_method=pdf_ocr_auto_raw`
   and calls `syncAll()` post-import, so every vacuumed+OCR'd citation registers
   a genuine auto version automatically. Backfill: `library:backfill-bib-canonicals`.
   Both hooks are best-effort — a canonical-layer failure never fails a scan or
   an import.
3. ✅ **Citation review reads through the canonical layer** (shipped 2026-06-11):
   `CitationReviewService::enrichCitationMetadata` resolves each citation
   bibliography → canonical (directly or via the foundation row) and classifies
   it into a provenance tier — **canonical** (work identity confirmed by
   external identifiers), **local** (library match, no canonical yet),
   **unverified**. Passage search runs against the canonical's best PUBLIC
   version with content (`BestVersionService::bestPublicContentVersion`,
   pgsql_admin — queue workers have no RLS session), preferring the untampered
   auto version over arbitrary user copies; falls back to the foundation row.
   The AI review report shows per-claim provenance lines ("Canonical-verified
   (OpenAlex, DOI) — content from the system-fetched auto version"), a
   canonical-verified count in the header, and highlight sub-books carry a
   ✓ canonical-verified marker. A canonical-linked citation with no library
   copy now counts as verified (metadata served from the canonical).
4. **Dormant authorities**: commoner score → `CommonsVersionResolver`; ORCID
   OAuth → `AuthorVersionResolver`; publisher verification →
   `PublisherVersionResolver`. Plus canonical dedup (UNIQUE constraints +
   merge tool) once scan-driven canonical creation raises volume.
