# End-to-end tests (Playwright)

Browser-driven tests that hit the real dev server and a real Postgres DB.
They exercise the SPA navigation flow, button registry lifecycle, and
component-level workflows (authoring, importing, editing, etc.).

## Running

**Always use the npm scripts** — they pass `--config tests/e2e/playwright.config.js`
which is required because the Playwright config isn't at the repo root and
plain `npx playwright test` from the root will silently fall back to
Playwright's default config (no `baseURL`, no auth setup, no projects). All
your `page.goto('/')` calls will fail with `Cannot navigate to invalid URL`.

```bash
# All e2e tests (headless)
npm run test:e2e

# All e2e tests (headed — watch the browser)
npm run test:e2e:headed

# A single spec file (note the `--` to forward args to playwright)
npm run test:e2e -- tests/e2e/specs/workflows/file-import-drag-drop.spec.js

# A single test by name
npm run test:e2e -- --grep "drop .md on home"

# Debug a single test (Playwright Inspector)
npm run test:e2e -- --debug tests/e2e/specs/workflows/file-import-drag-drop.spec.js
```

Reports land in `tests/e2e/report/` (HTML) and `tests/e2e/test-results/`
(traces, screenshots, videos for failures).

## Prerequisites

1. **Dev server running.** Tests hit `http://localhost:8000` by default. Start
   it with `npm run dev:all` (PHP + queue + Vite + mail) in another terminal.
2. **`tests/e2e/.env.e2e` exists** with at least:
   ```
   E2E_BASE_URL=http://localhost:8000
   E2E_USER_EMAIL=<real test account>
   E2E_USER_PASSWORD=<real password>
   E2E_READER_BOOK=<a book slug owned by the test user>
   E2E_READER_BOOK_2=<a second book slug>
   E2E_TEST_USERNAME=<test user's profile slug>
   ```
   The auth setup logs in as `E2E_USER_EMAIL` and saves the session to
   `fixtures/.auth-state.json`. All other tests reuse that session.
3. **Test user must exist** in the dev DB — auth setup doesn't create it. If
   login fails, register the account through the UI first.

## How tests are wired

```
playwright.config.js
  ├── projects[0] "setup"        → fixtures/auth.setup.js (logs in once)
  └── projects[1] "chromium"     → uses .auth-state.json from setup,
                                   runs everything in specs/
```

`fullyParallel: false` and `workers: 1` — tests are stateful (they create
real books in the DB and assume serial ordering for some flows).

## Spec layout

| Folder | Purpose |
|---|---|
| `specs/smoke/` | Fast sanity checks: pages load, registry healthy, no console errors. Run these first when debugging. |
| `specs/regression/` | Bug-fix regression tests. Add a new file here when you fix a bug worth pinning. |
| `specs/transitions/` | SPA navigation transitions (home↔reader, reader↔reader, back/forward, bfcache). |
| `specs/workflows/` | Multi-phase user journeys (authoring, importing, etc.). These are the slow ones. |
| `specs/divEditor/` | Editor-specific behaviors (mutations, selection, paste). |

## What each spec actually does

### `specs/smoke/`

| File | What it tests |
|---|---|
| `fresh-load.spec.js` | Cold-load each page type (home / reader / user) and assert: correct `data-page`, `buttonRegistry` healthy, no unfiltered console errors. The first thing to run when something feels broken. |

### `specs/regression/`

| File | What it tests |
|---|---|
| `globals-after-spa.spec.js` | After SPA navigation, page-scoped globals (`window.isUserPage`, etc.) reflect the *current* page, not the page we came from. Regression for stale-globals bugs. |
| `listener-accumulation.spec.js` | `document` event listeners stay stable across home→reader→home cycles. Catches the cleanup-leak class of bugs (listeners getting added on init but not removed on destroy). |
| `registry-after-spa.spec.js` | After every SPA transition, `buttonRegistry` has exactly the components for the new page type — no leftovers from the old page, no missing entries for the new one. |
| `toc-deep-nav.spec.js` | TOC (`#toc-toggle-button` → `#toc-container`) regression. Imports a long generated book, iterates every TOC entry, clicks it, asserts: URL hash updates, the matching heading is in the upper half of the viewport, no hyperlit container opens as a side-effect, and the TOC closes after each click. |

### `specs/transitions/`

These cover every cross-template SPA navigation path. Each file follows the
same shape: navigate via the realistic UI affordance (logo click, book card
click, hypercite link, etc.), wait for the transition to complete, assert the
new structure is correct and the registry is healthy.

| File | Path covered |
|---|---|
| `home-to-reader.spec.js` | Click a book card on `/` → `/{book}`. |
| `home-to-user.spec.js` | userButton → "My Books" from `/` → `/u/{username}`. |
| `reader-to-home.spec.js` | Logo click in reader → `/`. |
| `reader-to-user.spec.js` | userButton → "My Books" from a book → `/u/{username}`. |
| `user-to-home.spec.js` | Logo click on user page → `/`. |
| `user-to-reader.spec.js` | Click a book card on user page → `/{book}`. |
| `same-template.spec.js` | reader → reader (book to book) via clicking a hypercite link. Tests that template-identical transitions don't full-reload. |

### `specs/workflows/`

The big multi-phase tests. Slow but high-value — each one exercises a complete
user journey end-to-end.

| File | What it tests |
|---|---|
| `authoring-workflow.spec.js` | The flagship workflow test: create book 1 → type & format text (bold/italic/heading/blockquote/list) → create a hyperlight → create a hypercite → home → create book 2 → paste hypercite → click hypercite link to navigate back to book 1 → browser back/forward. Verifies edit toolbar, hyperlight rendering, hypercite link generation + paste handler, SPA navigation, and history state across the whole loop. |
| `file-import-drag-drop.spec.js` | Drag-and-drop file import (the new flow): drop a `.md` file on home → import form auto-opens with file pre-attached → submit → SPA transition to the imported book → enter edit mode and add content → exit edit mode (fires the integrity verifier) → navigate home → assert drop target re-initializes cleanly. Plus two negative cases: drop while form is already open suppresses the page-level overlay; reader pages don't register the drop target at all. |
| `spa-grand-tour.spec.js` | **The catch-all SPA correctness test.** 8 phases under one `describe.serial`: home/user/reader verifiers in isolation; a single tour lap through every cross-template transition; a three-lap tour to surface state-accumulation bugs; back-button replay to the start; forward-button replay to the end; deep authoring (create book + hyperlight + hypercite + sync) followed by a post-lap tour to verify authoring didn't poison subsequent SPA cycles. Each phase exercises every interactive component on the page (synthetic drops, tab switches, edit-mode toggle, container open/close) so a feature that mounts but doesn't function is caught. Whole spec runs in ~2 minutes. Use `--grep` to run individual phases during inner-loop development. |
| `nested-authoring-stress.spec.js` | Build a 4-level nest (footnote → hyperlight on its text → footnote → hyperlight) typing a known sentence at each level, with a short ~400ms wait between type and close to race the debounced IndexedDB write against save-on-close. Then navigate home and back, re-open every level through its rendered sup / hyperlight anchor, and verify every typed sentence is still present — proving no data loss in the DOM→IndexedDB→Postgres path. Final assertion: no integrity mismatches recorded, all sentences round-tripped. |
| `nested-hypercite-chain.spec.js` | Two tests. **(1) Build → chain → verify:** build a 3-deep nest, copy hypercites from each level, paste them at the level above (so every level cites the level below), then walk back and forward through history asserting URL + container depth at every popstate. **(2) Cross-book back-restore:** the load-bearing regression guard for the user-reported "press back from another book and the deep stack collapses" bug. Builds depth-3 stack in book A, navigates home, creates book B, pastes a hypercite, clicks it to navigate back to A, then walks back through history. Two strict assertions: (a) at the cross-book popstate boundary, visible stack === saved `historyStackDepth > 0` (catches `BookToBookTransition.updateUrlWithStatePreservation` regression nulling state); (b) at the original cs=3 entry, all 3 layers restored and all 4 typed phrases present (catches the closeContainer-mid-restoration regression). |
| `cross-book-hypercite-tour.spec.js` | Reproduces the "nightmare scenario" with a real long imported book (`rockhill.epub`). Imports Book A and B, creates a hypercite on a deep paragraph in A (mid-book, post-lazy-load), pastes it on a deep paragraph in B reached via the TOC. Then runs N loops of: TOC nav → footnote-stress (prime the hyperlit-container lifecycle) → click pasted hypercite → SPA nav to A → assert scroll-to-target landed in viewport and the container stack didn't flood → goBack → goForward → rapid back/forward bursts. A restoration spy records every hyperlit-container lifecycle event into `window.__restorationLog`. On test end, attaches three forensic artifacts: `state-timeline.json`, `summary.txt`, `anomalies.json`. Assertions are deliberately strict — designed to fail loudly if the user's "hella containers open and it glitches wild" bug reproduces. |
| `cross-book-navigation-stress.spec.js` | **Chaos/fuzz-style guard for cross-book container leaks** (regression for the 2026-05-16 "zombie containers stuck on top of book B" bug — see `hyperlitContainer/core.js`'s safety-sweep after stack unwind). Setup: creates book A with a depth-3 nest + hypercite, book B with a paste of that hypercite + its own footnote. Then walks through a fixed 30-step sequence of mixed actions (back-back-forward bursts, SPA navs between A and B, hypercite clicks, scroll, no-op forwards at end-of-history). At every step it snapshots state AND captures container *attribution* (which book each open/orphan container's content belongs to). Strict invariants per step: (a) zero orphan `.hyperlit-container-stacked` nodes without `.open` class (the literal zombies), (b) `visibleContainers === historyStackDepth` — drift = leak or failed restore. Also probes whether overlay clicks actually close visible containers (forensic capture of the "can't even be closed" symptom). Catches the bug class regardless of whether the root cause is in popstate restoration, BookToBookTransition cleanup, or a state-DOM desync elsewhere. |

### `specs/divEditor/`

| File | What it tests |
|---|---|
| `id-collision.spec.js` | Regression for a 2026-05-12 incident where `generateIdBetween` could mint a duplicate node ID, causing the integrity verifier to flag a mismatch. Two independent code paths (Bug A in `generateIdBetween`, Bug B in the editor's mutation handler) both contributed; both are pinned here. |

## Writing a new spec

Use the `test` and `expect` from the navigation fixture, not from
`@playwright/test` directly — the fixture installs a console-error monitor,
captures uncaught exceptions, and provides the `spa` helper bundle:

```js
import { test, expect } from '../../fixtures/navigation.fixture.js';

test('something', async ({ page, spa }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  expect(await spa.getStructure(page)).toBe('home');
  await spa.assertRegistryHealthy(page, 'home');

  // ... interactions ...

  spa.assertHealthy(await spa.healthCheck(page));
  expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
});
```

Available `spa.*` helpers (defined in `helpers/pageHelpers.js`):

- `getStructure(page)` — returns `'home'` / `'reader'` / `'user'` from `<body data-page>`.
- `waitForTransition(page)` — blocks until an in-flight SPA navigation completes.
- `healthCheck(page)` / `assertHealthy(result)` — checks IDB, listeners, DOM invariants.
- `getRegistryStatus(page)` / `assertRegistryHealthy(page, expectedPageType)` — verifies `buttonRegistry` state matches the page type.
- `navigateToHome(page)`, `navigateToUserPage(page)`, `clickFirstBookLink(page)`, `navigateViaHypercite(page)` — common SPA navigations.
- `selectTextInElement(page, selector, start, end)` — DOM range selection.
- `waitForEditMode(page)` / `waitForHyperlightButtons(page)` / `waitForCurrentBookId(page)` — editor state waits.
- `pasteHyperciteContent(page, html, text)` — synthetic paste event.
- `getListenerSnapshot(page)` / `getListenerDelta(page, prev)` — listener-leak detection (uses the monitor from `helpers/listenerMonitor.js`).
- `filterConsoleErrors(errors)` — strips known-noisy errors before assertion.

## Things that randomly seem to break (and how to unfuck)

- **Drag-and-drop on the homepage suddenly does nothing in Safari** → fully quit Safari (`Cmd+Q`, not just close window) and reopen. Safari's drag-and-drop state can wedge after rapid SW updates / dev edits. Hard-refresh alone won't fix it. Try a Private window first to confirm it's a stuck Safari runtime issue rather than a code bug.
- **`page.goto('/')` fails with "Cannot navigate to invalid URL"** → you ran `npx playwright test` from the project root instead of `npm run test:e2e`. The config file isn't at the repo root; the npm script passes `--config tests/e2e/playwright.config.js`. Always use the npm script.
- **Site loads but recent JS changes don't appear** → either Vite is dead (check `public/hot` exists) or you ran `npm run build` and Laravel is serving the prod bundle from `public/build/`. `npm run dev:network` (or `dev:all`) writes `public/hot` and Laravel switches back to the Vite dev server.
- **e2e tests pass but the feature looks broken in your browser** → the e2e tests run against the dev server with a clean browser context; your browser might have stale localStorage / SW / cookies. Try a Private window to isolate.
- **`Playwright` clicks a button and says "element is outside viewport"** → the perimeter buttons on home/user pages (e.g. `#importBook`) can sit just off-screen. Use `page.evaluate(() => document.getElementById('importBook')?.click())` instead of `page.click('#importBook')` — programmatic click bypasses the visibility check, same as how our drop handler opens the form internally.

## Things to watch for

- **Tests create real books.** Each authoring/import test creates a `book_<timestamp>` row in the dev DB. There's no cleanup — the dev DB accumulates them. Periodically prune if it bothers you.
- **`page.goto('/')` requires `baseURL`.** That comes from `playwright.config.js` (top-level `use.baseURL`). If you see `Cannot navigate to invalid URL`, you ran from the wrong directory or skipped the npm script.
- **Synthetic file drops.** For testing custom drop handlers (e.g. the homepage drop overlay), construct a `DataTransfer` in page context and dispatch `dragenter`/`dragover`/`drop` on `window`. See `specs/workflows/file-import-drag-drop.spec.js` for an example helper (`dropFileOnWindow`).
- **bfcache restore.** The fixture's `page` runs `addInitScript(listenerMonitorScript)` so listener counts persist across navigations and bfcache restores.
- **Screenshots/videos only on failure** — see `playwright.config.js` `use.screenshot` / `use.video`.

## Adding the auth setup to a fresh checkout

1. Register a dedicated test user via the UI (e.g. `e2e@test.local`).
2. Add the credentials and a couple of book slugs (created by that user) to `.env.e2e`.
3. Run `npm run test:e2e -- specs/smoke/fresh-load.spec.js` — this triggers `setup` first and writes `fixtures/.auth-state.json`.
4. Subsequent runs reuse the saved session.

If login itself broke (CSRF, route change, etc.), delete `fixtures/.auth-state.json` to force the setup project to re-run.
