# Tests

Everything under `tests/` — but it is several separate worlds, one per runner/language, and no single command runs them all. Knowing which runner owns a suite is the whole game: a PHP test never runs under an `npm` command, and an `npm` command never runs a PHP test. This file is the map; most subfolders also have their own README with the detail.

## The runners at a glance

- **Pest / PHPUnit (PHP)** — server logic: controllers, jobs, services, RLS, billing, auth. Run with `php artisan test`. Suites: `Unit`, `Feature`, `Canonical`. NOT in any `npm` command.
- **vitest (JavaScript, no browser)** — front-end unit tests + architecture guardrails. Run with `npm run test:run`. Scans `tests/javascript/` and `tests/paste/`.
- **Playwright (JavaScript, real browser)** — end-to-end user flows. Run with `npm run test:e2e`. Lives in `tests/e2e/`. Manual (not CI); some specs `test.skip` themselves without preconditions.
- **Python** — the PDF/OCR conversion pipeline regression. Run with its own Python runner in `tests/conversion/`. NOT in any `npm` command.
- **Plain PHP over HTTP** — the offensive red-team harness in `tests/security-redteam/`, run against a LIVE server. Not Pest; not CI.

Two traps worth stating up front: "in the `tests/e2e` directory" is NOT the same as "runs under `npm run test:e2e`" — the Stripe and security e2e specs have their own Playwright configs and only run when you name them (below). And use `npm run test:run`, never bare `npm test` — the latter is `vitest` in WATCH mode, which never exits and leaves orphaned CPU-spinning worker forks when killed non-interactively.

## PHP — Pest / PHPUnit (`php artisan test`)

The largest world: ~160 test files across three testsuites (defined in `phpunit.xml`), each hitting the real Laravel stack + a Postgres test DB with Row-Level Security enforced. `Pest.php` + `TestCase.php` are the shared bootstrap.

- **Run all three** — `php artisan test`
- **One suite** — `php artisan test --testsuite=Feature` (or `Unit` / `Canonical`)
- **One folder / file** — `php artisan test tests/Feature/Billing` or a single `…Test.php`

### The suites

- **Feature** (`tests/Feature/`, ~114 files) — HTTP endpoints, queued jobs, services, end-to-end through routes + DB. Subfolders: `AiBrain`, `Api`, `Auth`, `Billing`, `BookAudio`, `BookImages`, `CitationPipeline`, `Citations`, `E2ee`, `Import`, `Inference`, `Security`, `SourceHarvest`. Full run ~90s.
- **Unit** (`tests/Unit/`, ~25 files) — pure logic, no HTTP/DB. Seconds.
- **Canonical** (`tests/Canonical/`, ~21 files) — the canonical-source / version-control suite, kept as its own testsuite so it can run in isolation.

### The RLS gotcha (read before writing a PHP test that seeds data)

A bare `User::factory()->create()` is REJECTED by Postgres RLS — the `users` INSERT policy's `RETURNING` triggers the SELECT policy, which needs `app.current_user` set (unset during seeding). Seed through the BYPASSRLS `pgsql_admin` connection instead, via the `Tests\Support\SeedsRlsFixtures` trait (`seedUser` / `seedLibrary` / `seedNode`), which also cleans up its admin-committed rows in `afterEach`. The trait is bound to the seeding-heavy folders in `tests/Pest.php` — add a new folder to that list if it needs it. A charge/read that runs inside a test reads the ledger on the DEFAULT connection with the RLS session vars set, because the mutation lives inside the test's `RefreshDatabase` transaction and is invisible to `pgsql_admin`.

### `Feature/Security/` vs `security-redteam/`

The former is assertion-based, white-box, in-process, CI-safe — it proves a specific defense holds against a test DB. The latter (below) is black-box over real HTTP against a live server and REPORTS what it found. Run both; they catch different things.

## JavaScript unit — vitest (`npm run test:run`)

Front-end logic + architectural invariants, no browser. ~157 files in `tests/javascript/` (its own [README](javascript/README.md)) plus the paste engine's ~22 in `tests/paste/` (its own [README](paste/README.md)).

- **Run once** — `npm run test:run` (NEVER `npm test` — watch mode, see above).
- **Watch / visual** — `npm run test` / `npm run test:ui` (interactive dev only).
- **TDZ prod-bundle probe** — `npm run test:tdz` (`vite build` + `tests/build/tdzProbe.mjs`); catches circular-import crashes visible ONLY in the rollup prod bundle. Run before shipping front-end import restructures.

Beyond ordinary unit tests, `tests/javascript/architecture/` holds the RATCHET guardrails that keep the front-end honest: no new raw `console.*`, no new `: any` in tightened folders, interactive components go through `ButtonRegistry`, overlay surfaces declare focus wiring, the reading-position accessor is used, and the IndexedDB flow-map stays fresh. These READ `resources/js` source (the tests do not live there) and fail on a regression — see the review-gate sections in the root `CLAUDE.md`.

## Browser end-to-end — Playwright (`tests/e2e/`)

Real Chromium driving real user gestures. Manual, not part of CI — treat a green run with care (several specs `test.skip` when preconditions like a footnote-bearing seed book are absent, so "passed" can mean "never executed"). Full detail in [`e2e/README.md`](e2e/README.md).

- **Default suite** — `npm run test:e2e` (uses `playwright.config.js`, `testDir: ./specs`). Headed: `npm run test:e2e:headed`. One spec: `npm run test:e2e -- specs/workflows/authoring-workflow.spec.js`.
- **Accessibility** — `npm run test:a11y` (default config, `specs/a11y` + report merge).
- **Stripe billing** — its OWN config: `npx playwright test --config tests/e2e/playwright.stripe.config.js` (self-signs webhooks with the `.env` secret; `--grep @stripe-ui` drives the real hosted checkout; `RUN_LIVE_SPEND=1 … spend-live` bills your provider). NOT run by `npm run test:e2e`.
- **Security** — its own config: `tests/e2e/playwright.security.config.js`.

Always use the `npm` script for the default suite — a bare `npx playwright test` from the project root silently picks the wrong config (no `baseURL`, no auth setup) and fails with "Cannot navigate to invalid URL". Spec folders under `tests/e2e/specs/`: `a11y`, `ai-brain`, `audio`, `citations`, `divEditor`, `e2ee`, `footnotes`, `offline`, `performance`, `reader`, `regression`, `save-status`, `security`, `smoke`, `stripe`, `transitions`, `workflows`.

## Python — conversion pipeline (`tests/conversion/`)

The PDF/EPUB/HTML → markdown → nodes regression, run by its own Python harness (never `npm`, never Pest). It replays cached fixture OCR responses through `mistral_ocr.py` + `process_document.py` and asserts the ref/def/footnote/gap counts in each fixture's `manifest.json`. Full detail in [`conversion/README.md`](conversion/README.md).

- **All fixtures** — `python3 tests/conversion/run_regression.py`
- **One fixture** — `… --fixture <name>` · **verbose** — `… --verbose` · **machine-readable** — `… --json`
- **Rebless goldens** — `… --update-golden`
- **Vibe / co-evolution eval** — `python3 tests/conversion/vibe_eval.py`

Fixtures live in `tests/conversion/fixtures/<filetype>/<pathway>/` (e.g. `epub/basic_footnotes/`), each with a `manifest.json` of expected counts plus a cached `ocr_response.json` or `input.html`. `fixtures-local/` holds git-ignored local-only fixtures. Add one with `add_fixture.py` or by copying an existing folder and editing its manifest. Unit-level Python tests also live under `tests/conversion/unit/` (e.g. the byte-level PDF assembly snapshot).

## Offensive red-team — plain PHP over HTTP (`tests/security-redteam/`)

A black-box pen-test harness that registers throwaway accounts and actively attacks a RUNNING server (SQLi, IDOR, auth bypass, privesc, SSRF, DoS), writing a timestamped findings report. The "try to break in" counterpart to `Feature/Security/`. Not Pest, not CI. Its own [README](security-redteam/README.md).

- **Run** — `php tests/security-redteam/run.php --target=http://hyperlit.test`

## Support & fixtures (shared, not suites themselves)

- **`tests/Support/`** — PHP test helpers: `SeedsRlsFixtures` (RLS seeding, above) and `MakesWebAuthnCredentials` (E2EE passkey forging). Wired in `tests/Pest.php`.
- **`tests/fixtures/`** — shared input fixtures (citations, footnotes, JATS) for conversion/citation tests.
- **`tests/load/`**, **`tests/performance/`** — load/memory probes and perf baselines (e.g. `bundle-baseline.json`), not general suites.

## What is NOT a test suite

Two folders at the REPO ROOT (outside `tests/`) look test-related but hold no tests: `test-files/` (sample input documents used as fixtures) and `test-results/` (Playwright's per-run output artifacts — traces, screenshots).

## Same feature, tested in two worlds — on purpose

Many features have BOTH a PHP folder and an e2e spec folder (`ai-brain`, `audio`, `citations`, `e2ee`, `security`, billing). This is deliberate, not duplication: the PHP Feature tests prove the server logic deterministically against a real DB (fast, CI-friendly), while the Playwright specs prove the browser actually drives it end to end (manual, slow, catches SPA-lifecycle breakage nothing else does). Billing is the worked example — ledger math, RLS worker-context, regeneration, and the reader's pull endpoint are PHP (`tests/Feature/Billing`, `tests/Feature/AccountBookTest`), while Stripe checkout UI + webhook signing are Playwright (`tests/e2e/specs/stripe`, own config). When you touch a feature, check for its twin in the other world and update both; if a change spans layers, run all of them.

## Quick reference

- **All PHP** — `php artisan test`
- **PHP, one area** — `php artisan test tests/Feature/<Area>`
- **JS unit** — `npm run test:run` (never `npm test`)
- **JS TDZ prod-bundle probe** — `npm run test:tdz`
- **Browser e2e (default)** — `npm run test:e2e`
- **Accessibility e2e** — `npm run test:a11y`
- **Stripe e2e** — `npx playwright test --config tests/e2e/playwright.stripe.config.js`
- **Security e2e** — `npx playwright test --config tests/e2e/playwright.security.config.js`
- **Conversion regression (Python)** — `python3 tests/conversion/run_regression.py`
- **Red-team (live server)** — `php tests/security-redteam/run.php --target=<url>`
