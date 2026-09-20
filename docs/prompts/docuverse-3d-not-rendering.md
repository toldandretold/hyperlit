# Prompt: the 3D docuverse view "hasn't worked for ages"

> **STATUS 2026-09-19: NOT INVESTIGATED.** Reported by the project owner in passing during unrelated citation-study work. The notes below are the small amount established while confirming that a test failure was unrelated to it — they exist so a fresh session does not re-derive the wiring. Nothing about the actual breakage has been diagnosed, and the most likely explanation (first hypothesis below) has NOT been checked.

Paste everything below the line into a fresh session.

---

The standalone 3D docuverse view is reported as not working, and has apparently been broken for a long time without anyone chasing it. Find out whether it is genuinely broken or merely empty, then fix it.

## What is already established — do not re-derive this

- **Route:** `/3d/docuverse` → `App\Http\Controllers\DocuverseController::show`, named `docuverse.show`, declared in `routes/web.php` (~line 416). There is also a `/3d/{book}` variant. `/3d` is a deliberately PREFIXED namespace so a book slugged `docuverse` stays reachable — see the "Root routes are book names" review gate in `CLAUDE.md` before adding any route.
- **It is NOT an SPA page.** The comment in `routes/web.php` calls `/3d/*` "the reserved namespace for standalone non-SPA 3D views". So the usual dead-after-SPA-nav failure class (`@vite`-only side effects, see memory `spa-nav-dead-feature-registry`) is the WRONG thing to suspect first.
- **View:** `resources/views/docuverse.blade.php`. It loads `@vite(['resources/css/pages/docuverse.css'])` in the head and `@vite(['resources/js/docuverse3d/main.ts'])` near the end, plus two inline `<script>` blocks (around lines 14 and 125) worth reading before assuming the entry point is the only client code.
- **The vite entry exists and is registered:** `resources/js/docuverse3d/main.ts` and `resources/css/pages/docuverse.css` are both listed in `vite.config.js` (~lines 148–151). So this is not a missing-build-input problem at the config level. NOTE the folder is `docuverse3d/`, not `docuverse/` — an `ls resources/js/docuverse/` returns nothing and that is not a finding.
- **The backend is exercised and healthy.** The data source is `GET /api/docuverse/data?layers=…` (`DocuverseController`), and `tests/Feature/Api/DocuverseEndpointTest.php` passes 19 tests as of 2026-09-19 — covering the three edge layers (`hypercite` / `citation_verified` / `citation_auto`), the layer filter, the connected-only node rule, sub-book folding, and RLS visibility. Treat node/edge computation as probably fine and start on the client or the data volume.

## Check this FIRST: it may be correct-but-empty, not broken

The endpoint deliberately returns **connected nodes only** — "an orphan work is not on the map" (see the file docblock in `DocuverseController.php`). A map with no qualifying edges renders as nothing, which is indistinguishable from a broken renderer by eye, and would explain "hasn't worked for ages" without a single line of client code being at fault.

So before touching the front end, count what the endpoint would actually return against the live corpus: how many PUBLIC books carry a `canonical_source_id`, how many `bibliography` rows have `reference_verified_at` set, and how many `hypercites` rows join two visible books. If those are ~0, the bug is upstream (nothing is being minted / verified) and the renderer is innocent. Hit the endpoint directly as both an authenticated user and a guest — `curl` the JSON and count `nodes` / `edges` — rather than inferring from the page.

## Then, in order

- **Client runtime error.** Load `/3d/docuverse` and read the console. A single throw in `main.ts` leaves a blank canvas. Use the browser tooling rather than guessing; `mcp__claude-in-chrome__read_console_messages` with a pattern filter is the cheap way in.
- **Asset resolution.** Confirm the built manifest actually contains the `docuverse3d/main.ts` entry and that the page is not requesting a stale hashed filename. Related known traps: memory `dev-stale-js-service-worker` and `vite-hot-file-stale-ip` — a stale service worker or a hot file pointing at an old IP has faked "the JS is broken" here before.
- **Auth / RLS.** The tests cover a stranger and a guest seeing no edges into private books. If the live map is empty only when logged out, that is correct behaviour, not a bug.
- **Whatever renders it.** Only after the above, read `resources/js/docuverse3d/main.ts` and the inline scripts in the blade. Do not assume which 3D library is in use — check.

## House rules and traps

- Read memory `docuverse-3d-and-figure-viewer` first — the standing invariant there is that there is **ONE citations layer**; do not add a second.
- "How connected is this text" has exactly one definition, `App\Services\Connections\ConnectionCountQuery` (review gate in `CLAUDE.md`). The docuverse's edge layers are a different question from the connectedness SCORE, but if this work ends up counting edges for ranking, it must call that service and must never rank on `library.total_citations`.
- A green e2e run proves little: e2e is manual (`npm run test:e2e`) and several specs `test.skip` themselves when preconditions are absent. Treat skips as gaps.
- Backend suite is `php artisan test` (not `npm test`); front-end is `npm run test:run` — never bare `npm test`, which is watch mode and leaves orphaned workers.
- Do not git commit; the owner handles git.

## Explicitly unrelated

Two things surfaced next to this and are NOT part of it:

- **The citation-review study.** The 4-test failure that led to noticing this had nothing to do with the review pipeline, and `DocuverseEndpointTest` was simply the one name captured from a lost run log.
- **Task #32, test isolation.** `pgsql_admin` writes escape `RefreshDatabase` rollback (proven by probe), leaving ~164k nodes and ~10k library rows accumulated in `my_laravel_db_test`. That is a whole-suite problem; `DocuverseEndpointTest` is one of the well-behaved files (it has its own `afterEach` cleanup at lines 72–76). Do not conflate the two.
