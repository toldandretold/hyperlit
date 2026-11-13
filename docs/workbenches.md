# Workbenches

Hyperlit has ten operator workbenches — standalone pages built one at a time for the maintainer — and one of them, hypercites, is also open to shelf owners on their own shelf. This file is the map: what each one is for, how they are gated, where the code lives, and what must be true before another one is opened to non-admins.

The live index is `/maintainer` (admin-only), rendered from `config/workbenches.php`. A new workbench is added there; `tests/Feature/Api/MaintainerIndexTest.php` fails if a `/maintainer` page is missing from the list.

## The inventory

### Conversion quality

- **Conversion triage** — `/maintainer/conversion`. The queue of flagged conversions, each book in the real reader beside its original source. Resolve, reconvert, retract, add a note, download a case bundle, approve as golden. Code: `resources/js/workbenches/conversion/`, `MaintainerController`. Detail: `docs/maintainer-loop.md`.
- **Ambiguous citations** — `/maintainer/citations`. Bare-year citations that fit more than one bibliography entry. The answer patches the stored nodes and is re-applied on every reconvert. Code: `workbenches/citations/`, `Maintainer\CitationConsoleController`.
- **Conversion regression tests** — `/dev/conversion-tests`. The regression fixture corpus: coverage by footnote strategy and citation style, run the suite, add a fixture. One blade with inline script (`conversion-test-dashboard.blade.php`), `ConversionTestController`.

### Corpus building

- **Journal import** — `/maintainer/journal-import`, `/maintainer/journal-import/{slug}`. Per journal: enumerate, import, compare the pdf / html / ar5iv lanes, promote a version, certify. Code: `workbenches/journalImport/`, `Maintainer\JournalImportController`. Detail: `docs/journal-harvest.md`.
- **Shelf import** — `/maintainer/shelf-import`, `/maintainer/shelf-import/{id}`. The journal-import workflow over any public shelf, above all the system "Cited by:" shelves. Shares journal import's script and stylesheet (`window.__journalImport.mode = 'shelf'`). `Maintainer\ShelfImportController`.
- **Hypercites** — `/maintainer/hypercites`, `/maintainer/hypercites/{slug}`, `/maintainer/hypercites/shelf/{id}`. Detect citations between held works in a journal or a public shelf, review citing and cited side by side, approve to mint the hypercite, import the most-cited external sources. Code: `workbenches/hypercites/`, `Maintainer\HyperciteConsoleController`, `app/Services/Hypercites/`. **Also open to shelf owners** — see below.

### Research

- **Citation study** — `/maintainer/study`, `/maintainer/study/{slug}`. Adjudicate the AI citation review against a hand-curated corpus on disk (`study/corpora/{corpus}`): verdicts, failure causes, evidence quotes. Code: `workbenches/study/`, `Maintainer\StudyConsoleController`. Detail: `study/README.md`.

### Operations

- **Job failures** — `/maintainer/jobs`. `failed_jobs` grouped by what actually broke. Retry, forget, export a case bundle. Code: `workbenches/jobs/`, `Maintainer\JobsController`.
- **Storage** — `/maintainer/storage`. What is stored and how much is waste: by category, by user, orphans, deleted content. Code: `workbenches/storage/`, `Maintainer\StorageController`.
- **Reading stats** — `/maintainer/stats`. Site-wide views, likes and reading depth. Aggregates only. Code: `workbenches/stats/`, `Maintainer\StatsController`.

## How they are built

- Each is a standalone, non-SPA blade (`resources/views/maintainer-*.blade.php`) loading one stylesheet (`resources/css/pages/maintainer-*.css`) and one TypeScript entry (`resources/js/workbenches/<name>/main.ts`) through `@vite`. They are NOT ButtonRegistry components — that rule is for things that must survive SPA navigation, and these pages never SPA-navigate.
- `resources/js/workbenches/shared/http.ts` is the one HTTP seam: `csrfHeaders`, `getJson` (throws on non-2xx), `postJson` (returns the status beside the body, because 409 / 422 are displayable outcomes here). A standalone page bootstraps its own session, so a POST without the XSRF pair 419s — use these rather than a bare `fetch`.
- `resources/views/partials/maintainer-theme.blade.php` is the theme-before-paint script every workbench includes.
- The DOM helpers named `el` are deliberately NOT shared: they have different contracts per page (nullable lookup, non-null lookup, element factory).

## The admin gate

- **Pages** — the whole `/maintainer` route group carries `admin.page` (`RequireAdminPage`): guests and non-admins get a 404, so the pages are not advertised.
- **API** — everything under `/api/maintainer` and `/api/conversion-tests` sits in one `['auth:sanctum', 'admin']` group (401 for guests, 403 for non-admins).
- **Admin** means `users.is_admin`, read by `User::isAdmin()` over `pgsql_admin`. The column is not mass-assignable.
- The gate is on the route GROUP, and `tests/Feature/Architecture/MaintainerRoutesAdminOnlyTest.php` walks the real route table to prove every route carries it. Before this, each controller repeated the check and a forgotten one was a public page.

## The shelf-owner hypercite workbench

A shelf published as an archive (`/a/{slug}`) makes its owner the keeper of a small library, so the hypercite workbench is open to them on their own shelf at `/a/{slug}/hypercites`, reached from the archive panel's Creator Tools section.

It is the same page, script, detector and minter as the operator console. `ShelfWorkbench\HyperciteController` extends the console controller and overrides only who is asking; nothing is forked. What makes it safe for a non-admin:

- **A separate door.** Its API is `/api/shelf-workbench/{shelf}/hypercites/…` behind `auth:sanctum` + `shelf.owner`, never a loosened `/api/maintainer` route.
- **Who gets in** — `App\Services\Shelves\ShelfWorkbenchAccess`, the one definition used by the API gate, the page and the panel's `curateUrl`: you are the shelf's creator, the shelf is public, and it is an ordinary user shelf. An admin who is not the owner is refused here; the operator console is theirs.
- **Ids are checked against the shelf.** A candidate or run from another scope is "not found" on every verb.
- **What an owner may write** — `App\Services\Hypercites\WorkbenchActor`, enforced inside `HyperciteMinter` so batch approve cannot route around it: the citing book must be the owner's own (approving edits the citing book's text), and the cited book must be a system-held converted work. The second half is the anti-rigging rule — without it an owner could mint links into their own writing, or make a commons text appear to cite it. Rows the owner cannot approve are still listed, marked view-only with the reason.
- **Commons → commons links stay with the operator.** They are real links, but minting one edits a commons book. The operator approves them from `/maintainer/hypercites/shelf/{id}`.
- **Bounded reads.** An owner's detect walks only the shelf's public books and their own, never another user's private book that happens to be shelved.
- **Requester pays.** A detect that needs bibliography scans shows an estimate, needs credit, and bills each scan after it succeeds (`docs/billing.md` §"Bibliography scan for hypercite detection"). Importing a cited work goes through `SingleWorkImporter`, the user-billed front door, and lands on the owner's "Imported works" shelf.
- **Not offered** — auto-approve and bulk import. Both act as the operator.

Pinned by `tests/Feature/Api/ShelfHyperciteWorkbenchTest.php` and, in a real browser as a non-admin user, `tests/e2e/specs/workflows/shelf-hypercite-workbench.spec.js` (manual, `npm run test:e2e`; fixture `php artisan e2e:seed-shelf-workbench`).

## Opening another workbench to non-admins

Do not loosen an `/api/maintainer` route. Give the tool its own prefix and gate, then answer the same questions the hypercite workbench had to:

- Which rows can this person see, and is every id they send checked against that scope?
- What does each action WRITE, and to whose book? An action that edits content needs an ownership rule enforced at the write, not in the controller.
- What does it cost, who pays, and is there a credit check before the work is queued?
- Does any background job it starts run as the operator? If so it needs the same rule, or it is a way round.
