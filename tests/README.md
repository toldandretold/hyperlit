# Tests

This directory holds every kind of test in the project. Each subfolder uses a
different runner — read the per-folder section below to know which command to
run and what each test covers.

## Quick reference

| Folder | Runner | Command | Purpose |
|---|---|---|---|
| `Unit/` | [Pest](https://pestphp.com/) (PHP) | `php artisan test --testsuite=Unit` | Pure-PHP unit tests (currently sparse — example test only). |
| `Feature/` | Pest (PHP) | `php artisan test --testsuite=Feature` | Server-side feature tests: auth, security, file-upload validation, import pipeline. Hits Laravel HTTP layer with a fresh test DB. |
| `javascript/` | [Vitest](https://vitest.dev/) | `npm test` | JS unit tests (jsdom). Targets `divEditor/`, `editToolbar/`, paste utilities, `IDfunctions`, etc. — anything testable without a real browser. |
| `paste/` | Vitest (via `tests/javascript`) | `npm test paste` | Paste-flow processors and normalizers (Cambridge journal format, HTML→markdown, etc.). Has its own README. |
| `conversion/` | Plain Python | `python3 tests/conversion/run_regression.py` | Regression suite for the PDF/HTML→nodes conversion pipeline. Runs `mistral_ocr.py` + `process_document.py` against fixture OCR responses and asserts ref/def/footnote counts. |
| `e2e/` | [Playwright](https://playwright.dev/) | `npm run test:e2e` | Browser-driven end-to-end tests against a real local dev server + Postgres. Has its own [README](e2e/README.md). |

`Pest.php` and `TestCase.php` are the shared bootstrap files Pest uses.

## When to use which

- **Pure JS logic, no DOM coupling** → `tests/javascript/` (fast, no server needed).
- **Server endpoint / model / validation** → `tests/Feature/` (Laravel test DB, fast).
- **Conversion-pipeline change** (anything in `app/Python/mistral_ocr.py`, `process_document.py`) → `tests/conversion/` regression suite. Add a fixture if you fix a bug worth pinning.
- **UI interaction across the SPA** (button click, navigation, drag-drop, edit-mode toggle, save flow) → `tests/e2e/` Playwright. Slow but catches real-world breakage.

If a change affects multiple layers, run all of them — the e2e suite is the only one that catches regressions involving the SPA navigation lifecycle.

---

## `Unit/` (PHP unit tests, Pest)

Currently just `ExampleTest.php`. Add unit tests here when you have small,
pure-PHP functions or classes that are testable in isolation.

```bash
php artisan test --testsuite=Unit
# or just one file:
php artisan test tests/Unit/ExampleTest.php
```

## `Feature/` (PHP feature tests, Pest)

Server-side tests that boot a Laravel app instance and hit HTTP endpoints,
models, and middleware against a fresh in-memory or test-DB.

```bash
# All feature tests
php artisan test --testsuite=Feature

# A subset
php artisan test tests/Feature/Security/
```

Sub-folders:

- **`Api/`** — JSON contract tests for endpoints the SPA depends on. Currently `AuthApiContractTest.php` pins the response shape of `/api/auth-check`, `/api/auth/session-info`, and `/api/anonymous-session`. Asserts status code + JSON structure, not full controller behaviour — the goal is to fail loudly if a refactor renames a key the frontend reads.
- **`Auth/`** — login/registration flows, session management, password reset.
- **`Import/`** — file-upload pipeline (`ImportPipelineTest.php`): validates the controller accepts/rejects file types, runs the conversion, and produces expected output.
- **`Security/`** — XSS validation (`XssValidationTest.php`), SQL-injection war games (`SqlInjectionWarGameTest.php`), file-upload size/type guards (`FileUploadTest.php`), anonymous-content association rules (`AnonymousContentAssociationTest.php`).

Other top-level files: `ExampleTest.php`, `ProfileTest.php`.

## `javascript/` (Vitest, JS unit tests)

Has its own [README](javascript/README.md) — read that first. Briefly:

```bash
npm test                 # run once
npm test -- --watch      # watch mode
npm run test:ui          # visual UI
```

Covers:
- `editToolbar/` — `blockFormatter`, `selectionManager`, `toolbarDOMUtils`.
- `indexedDB/` — pure helpers extracted from `batch.js` (`resolveBookIdForBatch`) and `master.js` (`filterFreshNodesForBook`). These pin the sub-book attribution and cross-book sync-filter logic so the bugs they were extracted from can never silently come back.
- `security/` — `sanitizeConfig` rules.
- `setup/` — shared test setup (jsdom, mock IDB, etc.).
- `hyperCites.test.js` — hypercite-link generation logic.

## `paste/` (Vitest, paste-flow tests)

Has its own [README](paste/README.md). These run via the same Vitest runner
as `javascript/`. Covers:
- `format-processors/` — per-publisher format converters (e.g. `cambridge-processor.test.js`).
- `utils/` — content estimator, normalizer, etc.

## `conversion/` (Python regression, no test runner)

Single script that drives the conversion pipeline against fixture OCR
responses and asserts `conversion_stats.json` / `audit.json` counts match
the expected values stored in each fixture's `manifest.json`.

```bash
# Run all fixtures
python3 tests/conversion/run_regression.py

# One fixture
python3 tests/conversion/run_regression.py --fixture whole_document_example

# Verbose output (shows pipeline stdout/stderr on failure)
python3 tests/conversion/run_regression.py --verbose

# Machine-readable output (CI integration)
python3 tests/conversion/run_regression.py --json
```

Fixtures live in `tests/conversion/fixtures/<name>/`. Each contains:
- `manifest.json` — expected counts (`references_count`, `citations_linked`, `footnotes_count`, `audit_gaps`).
- Either `ocr_response.json` (full pipeline) or `input.html` (HTML-only pipeline).
- Optional supporting files (`footnote_meta.json` etc.).

To add a new fixture, use `add_fixture.py` or copy an existing one and edit
the manifest. `import-samples/` holds raw source samples used to generate
fixtures.

Current fixtures (May 2026):

| Fixture | Pipeline | Purpose |
|---|---|---|
| `peerreview2027` | html-only | Bracket `[Author, Year]` citations, no footnotes, 40 refs, garbled OCR prefixes — guards the bibliography parser against OCR noise. |
| `stem_bibliography_example` | full | `wackSTEMbibliographyNotes` classification — STEM-style numbered citations with bibliography. |
| `whole_document_example` | full | `document_endnotes` classification, sequential footnote strategy, 243 refs, 2 footnotes — the largest end-to-end smoke test. |

## `e2e/` (Playwright, end-to-end browser tests)

See [`e2e/README.md`](e2e/README.md) for full details. The short version:

```bash
npm run test:e2e                                                    # all
npm run test:e2e -- specs/workflows/authoring-workflow.spec.js      # one
npm run test:e2e:headed                                             # watch the browser
```

**Always use the npm script** — `npx playwright test` from the project root
silently uses the wrong config (no `baseURL`, no auth setup) and fails with
"Cannot navigate to invalid URL".
