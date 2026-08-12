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

## The public pages

Every registry journal gets a page at `/j/{slug}` (e.g. `/j/global-social-challenges-journal`), and `/j` lists all diamond journals ranked by citations. The page shows the journal header (publisher, ISSN, diamond badge, website) and its works most-cited first; each work links to its best readable version via the version-pointer precedence. Linking rule: a visible version WITH content links immediately, marked *unreviewed* until a maintainer has looked at it — junk gets flagged and retracted (which deletes it and drops it off the page), so the page never has to wait for per-article approval. The shelf link and these pages both rely on the `canonicalizer_v1` system user seeded by migration `2026_08_12_000003` (commons shelves live under `/u/canonicalizer_v1/shelf/…`).

Useful flags: `--skip-ocr` (fetch PDFs but don't OCR — nothing charged), `--sleep=N` (seconds between works, default 2), `--type=` (empty for all citable work types, default `article`).

## Where the code lives

- `DoajJournalDirectory.php` (this folder) — the diamond-OA authority: DOAJ CSV/API lookups + the `isDiamond` rule. OpenAlex's `apc_usd` can NOT detect diamond (null = unknown, not free).
- `app/Console/Commands/JournalSyncRegistryCommand.php` / `JournalListCommand.php` / `JournalHarvestCommand.php` — the three commands.
- `app/Http/Controllers/JournalPageController.php` + `resources/views/journal.blade.php` / `journal-index.blade.php` — the `/j` pages.
- `app/Models/JournalSource.php` — the `journal_sources` registry row.
- `app/Services/OpenAlex/SourcesApi.php` + `SourceNormaliser.php` — the `/sources` client; `WorksApi::fetchBySourcePage` — journal works enumeration (cursor paging).
- `app/Services/SourceHarvest/HarvestEligibility.php::eligibleCanonicalsForJournal` — the journal-rooted select stage; `HarvestShelf::ensureJournalShelfFor` — the public shelf; `WorkOcrCharger.php` — the ONE home of the set-both-RLS-vars OCR billing pattern.
- Shared with the per-paper harvester (untouched): `AutoVersionCreator`, `ContentFetchService`, the maintainer review loop.

Tests: `tests/Feature/JournalRegistry/` (registry sync, harvest command, journal pages), `tests/Feature/SourceHarvest/JournalEligibilityTest.php`, `tests/Feature/SourceHarvest/CommonsShelfUrlTest.php`, `tests/Canonical/SourceNormaliserTest.php`.
