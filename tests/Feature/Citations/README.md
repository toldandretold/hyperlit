# Citation Modal Test Suite

Cross-cutting documentation for every test that covers the citation search
modal — Pest Feature + Unit, Vitest, Playwright. Source files all link back
to this README in their header comments.

## What the modal does

The citation modal (`#citation-mode-container`, driven by
`resources/js/editToolbar/citationMode.js`) lets a user search the library
and insert an inline `(Author Year)` citation into their writing. It does
**hybrid search** across two tables:

- `canonical_source` — citation identity (a work, not a copy)
- `library` — orphan rows that aren't linked to a canonical (user imports,
  unpublished work)

External sources (OpenAlex, Open Library) supplement the local search on
public scope when results are thin. New external hits are written to
`canonical_source` only, never to `library`.

See `docs/canonical-sources.md` for the data model.

## Architecture quick map

| Layer | File | Tests |
|---|---|---|
| Frontend modal | `resources/js/editToolbar/citationMode.js` | Vitest `citationMode.test.js` + Playwright `citation-modal-*.spec.js` |
| Citation insert / bibliography write | `resources/js/citations/citationInserter.js` | Vitest `citationInserter.test.js` |
| Click-handler resolver | `resources/js/indexedDB/bibliography/index.js` | Vitest `bibliographyResolver.test.js` |
| Mobile keyboard panel positioning | `resources/js/keyboardManager.js` (moveToolbarAboveKeyboard) | Playwright `citation-modal-mobile.spec.js` |
| Controller | `app/Http/Controllers/SearchController.php::searchWithOpenAlex` | Pest Feature `CitationSearchTest.php` |
| Service orchestrator | `app/Services/CitationSearchService.php` | Pest Unit `CitationSearchServiceTest.php`, Feature `CitationSearchTest.php` |
| Hybrid SQL | `app/Services/SearchService.php::searchForCitations` | Pest Feature `CitationSearchTest.php` |
| Canonical ingest wrapper | `app/Services/CanonicalSourceMatcher.php::ingestExternal` | Pest Unit `CitationSearchServiceTest.php` |
| Click-time best-version resolver | `app/Http/Controllers/CanonicalSourceController.php::bestVersion` | Pest Feature `CanonicalBestVersionTest.php` |
| Legacy stub cleanup | `app/Console/Commands/BackfillCitationStubsCommand.php` | Pest Feature `StubBackfillTest.php` |

## Test inventory

### Pest Feature — `tests/Feature/Citations/`

| File | Locks |
|---|---|
| `CitationSearchTest.php` | Full request-response contract on `/api/search/combined`. Privacy (public/mine/shelf, including caller's own private books in `mine` per attribution-first), hybrid result shapes, external lookup gating (only on `public + offset=0 + <limit local hits`), canonical-only ingest (zero new `library` rows), cache short-circuit, validation 422/404, OpenAlex 429 + OL 500 degradation, `is_private` flag follows the resolved version, scope-bound canonical leak regression (the "2-book shelf returning 50 results" bug). |
| `CanonicalBestVersionTest.php` | `GET /api/canonical/{id}/best-version`: precedence (author > publisher > commons > auto > any visible), privacy (no leak to other users), 404 / non-uuid route constraint. |
| `StubBackfillTest.php` | `library:backfill-citation-stubs` Artisan command: deletes orphan OpenAlex/OL stubs, creates canonicals, rewrites pointing bibliography rows, idempotent, dry-run is read-only, `--limit` respects the cap. |

### Pest Unit — `tests/Unit/Services/`

| File | Locks |
|---|---|
| `CitationSearchServiceTest.php` | Pure orchestration with Mockery: scope gating (no external on mine/shelf/offset>0), ingest routing through `CanonicalSourceMatcher::ingestExternal`, `OpenAlexService::upsertLibraryStubs` is NEVER called from this service, cache TTL + case-insensitivity. |

### Vitest — `tests/javascript/`

| File | Locks |
|---|---|
| `editToolbar/citationMode.test.js` | Scope chips (visibility, localStorage, URL building), focus-keeper (`mousedown` / `pointerdown` preventDefault keeps input focused), custom shelf dropdown (button + popup, not native `<select>`), `_shelfInteractionAt` window, click-outside-dropdown closes JUST the popup, ESC closes popup before modal, `handleResultsScroll` doesn't eat chip taps (interactive-element exception), private-lock badge rendering, regression tests for type→clear→Shelf trap. |
| `citations/citationInserter.test.js` | `parseAuthorYear` edge cases, `generateReferenceId` format, `insertCitationAtCursor` with both new picked-object shape AND legacy positional signature, bibliography record includes both `source_id` and `canonical_source_id` pointers. |
| `indexedDB/bibliographyResolver.test.js` | `resolveBibliographyTarget`: canonical → best-version, citation-card fallback when no version, network-error fallback to `source_id`, legacy `source_id`-only records, `source_has_nodes` backward-compat. |

### Playwright — `tests/e2e/specs/citations/`

| File | Locks |
|---|---|
| `citation-modal-scope.spec.js` | Scope UI on desktop viewport: chip presence, defaults, shelf picker visibility, persistence, URL `sourceScope` param, scope-change-re-fires-with-offset-reset, type→clear→Shelf regression. |
| `citation-modal-insertion.spec.js` | Full insertion flow: open modal, type, pick, verify inline `(Author Year)` in DOM + bibliography IDB record with both pointers. Canonical-only result writes `canonical_source_id` only. |
| `citation-modal-mobile.spec.js` | Mobile viewport (iPhone 13 emulation, `hasTouch: true`): chip bar inside visible viewport, panel non-zero height (regression for stale `height: 0` in keyboardManager), shelf trigger reveals popup, REAL touch via `page.tap()` fires scope change (regression for `handleResultsScroll` swallowing taps), chip tap does NOT blur input (regression for keyboard-dismissal), full FULL FLOW (chip → trigger → option) keeps modal open at every step. |

## Running

```bash
# Pest (Feature + Unit)
php artisan test --filter=Citation

# Vitest (3 files, ~95 tests)
npm run test:run -- tests/javascript/editToolbar/citationMode.test.js \
                    tests/javascript/citations/citationInserter.test.js \
                    tests/javascript/indexedDB/bibliographyResolver.test.js

# Playwright (citation specs only)
cd tests/e2e && npx playwright test specs/citations/

# Mobile Playwright only
cd tests/e2e && npx playwright test specs/citations/citation-modal-mobile.spec.js
```

The Playwright suite needs a live Laravel server (defaults to
`http://localhost:8000`) and `.env.e2e` with test credentials — see
`tests/e2e/playwright.config.js`.

## Conventions used in the citation tests

### Cross-connection seeding (Pest Feature)
Every seed (`citationSeedLibrary`, `citationSeedCanonical`, `citationSeedUser`,
`citationSeedShelf`) writes via the `pgsql_admin` connection to bypass Row-
Level Security. Reads go through whichever connection production code uses.
This is why some tests need `citationActAs($user)` to set RLS session vars
(`app.current_user`, `app.current_token`) before the search runs — without
them, shelf JOINs return 0 rows and library RLS hides the caller's own
private rows.

### Pest `toContain($a, $b)` gotcha
`expect($array)->toContain($a, $b)` asserts BOTH `$a` AND `$b` are present —
the second arg is NOT a failure message. Several earlier mistakes here:
always pass a single value per call and chain with `->and(...)->toContain(...)`.

### `Http::fake()` for external APIs
Fixtures live in `tests/fixtures/citations/` (`openalex-works-*.json`,
`openlibrary-*.json`). `CitationSearchTest.php` was the first place
`Http::fake()` got introduced into this codebase — pattern can be reused
for any other external-API integration.

### Mobile Playwright — real touch vs synthetic click
Use `page.locator(...).tap()` (real touch sequence) for any test that depends
on touch-specific behaviour like `mousedown.preventDefault` keeping focus.
`page.click()` injects a synthetic click and bypasses the touchstart →
mousedown → click chain — which is precisely the chain that was broken in
the early version of this work (it would silently pass `click()` tests while
real iOS was broken).

### iOS-specific limitations
Playwright runs Chromium with mobile-viewport emulation. It does NOT
reproduce iOS Safari's:
- Native `<select>` picker (we replaced it with a custom dropdown specifically
  because the native one always dismissed the iOS keyboard)
- Visual viewport / keyboard dismissal heuristics

Real-device verification still requires Safari Web Inspector connected to a
physical iPhone. The Playwright tests catch logic regressions; they can't
catch every iOS-OS-level behaviour.
