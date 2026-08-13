# Journal Harvest — operator guide

Import an entire open-access journal into the commons, one journal at a time. Companion design doc: `docs/journal-harvest.md` (data model, why DOAJ decides "diamond", follow-ups). This README is the how-to.

The flow in one line: **register the journal → dry-run → harvest ONE article → review it → scale up → next journal.**

## Step 0 — one-time setup

Nothing to install. Migrations `2026_08_12_000001/2` create `journal_sources` and `canonical_source.journal_source_id` (already run on dev). You need an admin account name for OCR billing (`--user=`); JATS/HTML imports are free, only Mistral-OCR'd PDFs charge.

## Step 1 — register a journal in the registry

By ISSN (the usual path — grab it from the journal's site or DOAJ):

```
php artisan journal:sync-registry --issn=2752-3349
```

Prints the diamond determination and the minted slug. It REFUSES journals that aren't provably diamond (DOAJ says they charge an APC, or DOAJ has no record) — override with `--include-non-diamond` if you deliberately want one anyway.

Or fill the whole registry and pick from it:

```
php artisan journal:sync-registry --limit=500    # most-cited 500 diamond journals
php artisan journal:list                         # the ranked worklist
```

## Step 2 — dry-run the journal

```
php artisan journal:harvest global-social-challenges-journal --dry-run
```

Enumerates every work via OpenAlex (no writes, no fetches, free) and prints how many are eligible. Accepts a slug, an OpenAlex S-id, or an ISSN.

## Step 3 — test on ONE article first

```
php artisan journal:harvest global-social-challenges-journal --max-works=1 --user=<your admin username>
```

`--max-works=1` harvests exactly one work — the journal's most-cited eligible article — through the full pipeline: fetch ladder (JATS/HTML full text preferred, PDF+OCR fallback) → import → `listed=false` library row → canonical pointer. The summary prints the book id, the lane it came in through (`via`), and what it cost. Everything is idempotent: re-running never re-imports what's already assigned, and Ctrl-C mid-run is always safe.

To test one SPECIFIC article instead of the most-cited one: find its canonical id (`select id, title from canonical_source where journal_source_id = ...` after a dry-run has upserted them — or just after step 3, which enumerates everything) and use the existing single-canonical tool:

```
php artisan library:create-auto-versions --canonical=<uuid>
```

## Step 4 — review the conversion

The imported book is link-accessible but unlisted. Check it before scaling:

```
php artisan harvest:audit-imports --stats     # then --flag to flag body-absent junk
```

Then open `/maintainer/conversion` — approve flips `listed=true`, retract deletes the version and frees the canonical for a re-harvest. This is the same loop as the per-paper harvester; nothing new to learn.

## Step 5 — scale up, journal by journal

```
php artisan journal:harvest global-social-challenges-journal --max-works=25 --user=<you>
```

Re-run until it says "journal fully harvested" (each run resumes where the last stopped; `remaining eligible` is printed at the end). Assigned books collect on a public `Journal: <name>` shelf. Then `php artisan journal:list` shows `last harvested` and you pick the next journal down the citation ranking.

## The operator console: /maintainer/journal-import

`/maintainer/journal-import` lists journals — what's already underway (with imported/remaining counts) and the ranked worklist of what's next, straight off the registry. Clicking one opens `/maintainer/journal-import/{slug}`: every article the journal has, and under each article every imported **lane**.

A lane is one system version of a work. A work can carry two — the vacuumed PDF (`foundation_source: canonical_pdf_vacuum`) and the publisher HTML (`journal_html`) — as sibling library rows with their own book ids and artifacts. That's the ar5iv pattern, not new machinery. Click a lane to see what we produced beside what we produced it from (the PDF, or the fetched publisher page), with the acquisition evidence from `fetch_trace.json` shown as badges.

**★ make version** promotes the selected lane: it points `canonical_source.auto_version_book` at that book, lists it, unlists its siblings, and swaps it onto the journal's shelf so the feeds follow. Only one lane is ever public; the other stays imported and unlisted so you can keep comparing. Same thing from the CLI: `php artisan journal:promote-version <book>`. Promotion refuses a lane with no content, and refuses `html_scrape_unverified` — that method means the authenticity gate never confirmed the page IS the article.

Importing the HTML lane: `php artisan journal:harvest <slug> --lane=html --max-works=N` (or `--lane=both`). It's free — only the PDF lane runs OCR — and it selects on its own predicate: works with no converted HTML lane yet, INCLUDING ones the PDF pass already claimed (the normal eligibility rule skips those, and they're exactly the ones worth comparing).

### Acting on an article from the console

Selecting a **lane** gives you, besides `open ↗` and `★ make version`:

- **↻ reconvert** — re-run the converter over the page already on disk. No network, no cost. This is the second half of the fix loop: spot a bad conversion on prod, bundle it, fix the processor locally, ship, then reconvert. The input is held constant, so anything that changes in the output is your fix — re-fetching instead would change the input too and you'd no longer know which one moved. The PDF lane's reconvert runs through the shared `/maintainer/conversion` path (it has an `original.pdf` plus an OCR cache, so re-running is free); re-acquiring a PDF is a retract-and-re-harvest, not a button.
- **⇩ re-fetch** (HTML lane) — go back to the publisher. For when what we stored isn't the article: empty, paywalled, or the wrong page.
- **⤓ conversion** / **⤓ harvest** — the same fork in bundle form. `conversion` blames the converter and replays through `run_regression.py`; `harvest` blames acquisition and ships `canonical_source` + `fetch_trace.json`. Choosing one IS the diagnosis, which is why neither is the default.

The **source pane is painted in your current theme** (dark / light / sepia). It renders a raw fetched publisher page whose own stylesheets mostly don't resolve here, so left alone it paints no background and falls back to near-black text — black on dark. The frame is same-origin, so `resources/js/utilities/sourceFrameTheme.ts` injects a stylesheet into it, reading the live custom properties so a theme change needs no work. Fidelity isn't the goal — this pane is for READING what we fetched; the publisher's real design is one `open ↗` away. A PDF lane is deliberately left alone and gets a light canvas instead: the decision comes from the artifacts on disk, never from the loaded document, because WebKit hands its PDF viewer a real `body` and a "has a body" check would happily inject a stylesheet into the viewer.

Above the converted output sits the same detail strip `/maintainer/conversion` has: the **book id, click to copy**, an `open ↗` link, the lane and its conversion method, and a **note** button. The editor is collapsed behind that button — it's occasional, and a permanent textarea steals height from the conversion you're here to read — and carries a **dot when a note is saved**, so you can see which lanes you've already written up while scanning with it shut. It collapses when you change lane (an editor left open over another lane's note is how the right words get saved against the wrong book) but stays open across a save, so ✓ fixed / ✕ dismiss are still under your cursor. The note is stored on the book's open conversion flags and travels with the case bundle, so the dev side reads your diagnosis beside the artifacts. A lane nobody has flagged gets a `manual` flag opened for it — you spotted the bad conversion, so that IS the report, and a note with nowhere to live would never reach the bundle.

**✓ fixed** / **✕ dismiss** close the case here — they appear only once there is an open one. They deliberately do NOT call the shared `/maintainer/conversion` resolve: that one treats approval as the listing gate (`promoteApprovedHarvest`) because a flagged book is the only version of its work, but a journal work has sibling lanes and exactly one may be public — so closing a case on the LOSING lane there would quietly publish a second version of the same article. Here listing follows only when the lane is already the promoted one, and `★ make version` stays the only way to publish a lane.

### What a bundle tells the dev side

`manifest.json` now carries, besides `book` / `case_kind`:

- **`origin`** — which console exported it (`journal-import`), so a case off a journal lane is distinguishable from one off the generic conversion queue.
- **`lane`** — `foundation_source`, `conversion_method`, whether this is the promoted version, and every **sibling** lane with the same three facts. A journal article carries two conversions of one work, so "which book is this" doesn't say which lane broke or whether the other is fine — and for a harvest case that IS the diagnosis ("the HTML lane came back empty" points somewhere different from "the PDF lane won the wrong edition").
- **`journal`** — slug, display name, publisher, ISSN-L and the console URL. The `journal_sources` row is dumped into `db/` and imported insert-if-absent, because otherwise `canonical_source.journal_source_id` resolves to nothing locally and you can't open the case you just pulled in your own journal-import console.

Selecting an **article with no lanes** offers `PDF`, `HTML` or `both`. HTML is free; PDF runs OCR and is charged to whoever pressed it.

All of these queue a `JournalImportActionJob` on `citation-pipeline` (the source harvester's worker) and write to a `journal_import_runs` row that the page polls — they fetch, OCR and cost money, so none of them run inside the request. A run that stops reporting for 30 minutes is failed by the poll's watchdog rather than spinning forever. A second run against the same target joins the first instead of starting a rival one: these actions replace a book's nodes, and two at once would interleave their writes.

GOTCHA worth knowing before you add another re-import path: every one of them ends in `ContentFetchService::persistArticle`, which rewrites the row with `listed = false`. On the promoted lane that is a silent demotion — the article drops out of `/j` and the journal shelf with nothing said. Both the job and `--force-html` re-promote afterwards; `tests/Feature/JournalRegistry/JournalLaneTest.php` locks it.

Re-converting after a processor fix from the CLI: `--force-html` re-fetches and re-converts lanes that ALREADY have content, which is the only way an improvement to a publisher processor reaches articles imported before it. Nodes are replaced wholesale, not appended. It also re-promotes afterwards when the lane was the version: the import rewrites the row with `listed = false`, so without that step a reconvert would quietly drop the article out of the journal's feeds.

Worked example, the GSCJ pilot article: the PDF lane gives 4 headings and 46 references (OCR dropped "References" and "Conflict of interest" from its output entirely); the HTML lane gives all 6 headings and 50 references — the publisher's real count.

## The public pages

Every registry journal gets a homepage-class page at `/j/{slug}` (e.g. `/j/global-social-challenges-journal`) — the lava-lamp hero with the hyperlit logo + the journal's name, about copy, and three feed buttons: **Most Recent** (publication order: year → volume → issue), **Most Connected**, **Most Lit** — scoped to that journal's articles. `/j` lists all diamond journals ranked by citations.

The feeds are **shelf-backed**: the buttons drive the existing public shelf render endpoint (`sort=published|connected|lit`) against the journal's shelf, so a feed costs nothing until someone actually visits it and rides all the existing shelf machinery (lazy render, cache invalidation, scoped search). `journal:sync-shelves {slug?}` reconciles shelf membership with the canonical truth (`canonical_source.journal_source_id`) and heals year/volume/issue onto version rows; `journal:harvest` runs the same reconcile in its stage 4. The search box on the page searches THIS journal only (public shelf search endpoint).

The about copy auto-composes from DOAJ metadata (keywords, LCC subjects, license, peer-review process, links to the journal website / aims & scope / editorial board — synced by `journal:sync-registry`); override it wholesale with `php artisan journal:set-about {slug} "..."` (`--clear` reverts to the composed default).

Publication-order sorting needs volume/issue: they flow OpenAlex work → `canonical_source.volume/issue` → minted library row. Journals enumerated before those columns existed heal on the next `journal:harvest` run (stage 1 backfills canonicals; `--max-works=0` = enumerate/backfill only, fetch nothing) followed by `journal:sync-shelves`.

The shelf link and commons shelves rely on the `canonicalizer_v1` system user seeded by migration `2026_08_12_000003` (commons shelves live under `/u/canonicalizer_v1/shelf/…`).

Useful flags: `--skip-ocr` (fetch PDFs but don't OCR — nothing charged), `--sleep=N` (seconds between works, default 2), `--type=` (empty for all citable work types, default `article`).

## Where the code lives

- `DoajJournalDirectory.php` (this folder) — the diamond-OA authority: DOAJ CSV/API lookups + the `isDiamond` rule. OpenAlex's `apc_usd` can NOT detect diamond (null = unknown, not free).
- `app/Console/Commands/JournalSyncRegistryCommand.php` / `JournalListCommand.php` / `JournalHarvestCommand.php` — the three commands.
- `app/Http/Controllers/JournalPageController.php` + `resources/views/journal-home.blade.php` / `journal-index.blade.php` — the `/j` pages; `JournalAboutComposer.php` (this folder) — the default about copy.
- `app/Console/Commands/JournalSyncShelvesCommand.php` / `JournalSetAboutCommand.php` — shelf reconcile + operator copy.
- `resources/js/components/journal/journalSearch.ts` — journal-scoped search; SPA structure `'journal'` lives in `resources/js/SPA/` (structureDetection, initHelpers, viewManager gates).
- `app/Models/JournalSource.php` — the `journal_sources` registry row.
- `app/Services/OpenAlex/SourcesApi.php` + `SourceNormaliser.php` — the `/sources` client; `WorksApi::fetchBySourcePage` — journal works enumeration (cursor paging).
- `app/Services/SourceHarvest/HarvestEligibility.php::eligibleCanonicalsForJournal` — the journal-rooted select stage; `HarvestShelf::ensureJournalShelfFor` — the public shelf; `WorkOcrCharger.php` — the ONE home of the set-both-RLS-vars OCR billing pattern.
- Shared with the per-paper harvester (untouched): `AutoVersionCreator`, `ContentFetchService`, the maintainer review loop.

Tests: `tests/Feature/JournalRegistry/` (registry sync, harvest command, journal pages), `tests/Feature/SourceHarvest/JournalEligibilityTest.php`, `tests/Feature/SourceHarvest/CommonsShelfUrlTest.php`, `tests/Canonical/SourceNormaliserTest.php`.
