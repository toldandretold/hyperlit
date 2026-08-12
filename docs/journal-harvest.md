# Journal-Level Harvest (Diamond OA Registry)

The mission-level extension of the per-paper Source Network Harvester: instead of harvesting the sources *cited by* one book, harvest *every open-access work of one journal*, journal by journal, building toward hosting all diamond open-access research. Step-by-step operator guide: `app/Services/JournalHarvest/README.md`. Everything downstream of work selection is the existing harvest machinery — `AutoVersionCreator` → the `ContentFetchService` acquisition ladder → `listed=false` mint → `/maintainer/conversion` review — so a journal harvest is also a conversion-quality stress test for that journal's PDF style.

## The registry (`journal_sources`)

One row per journal (OpenAlex "source"): venue identity (`openalex_source_id` S-id, `issn_l`, `issns`), display metadata (`display_name`, `publisher`, `homepage_url`, `topics`, `languages`, `country_code`), the diamond determination (`is_diamond` + `diamond_provenance`), ranking stats (`works_count`, `cited_by_count`, `two_year_mean_citedness`), and harvest bookkeeping (`last_harvested_at`, `harvest_stats` jsonb, `shelf_id`). Each row also carries a `slug`, minted once and never rewritten — it is the journal's public page URL at `/j/{slug}` (the `j` segment is declared in `config/reserved-routes.php`).

Works link to their journal via `canonical_source.journal_source_id`, stamped at enumeration time. This — not the free-text `canonical_source.journal` string — is the join key: it makes journal-rooted eligibility an indexed SQL predicate (`HarvestEligibility::eligibleCanonicalsForJournal`) and will power the `/j/{slug}` works listing.

## Why DOAJ, not OpenAlex, decides "diamond"

Diamond = free to read AND free to publish (no APC). OpenAlex's `apc_usd` field cannot answer this: null means "unknown", not "free" — filtering `/sources` on `is_oa:true,is_in_doaj:true,apc_usd:0` matches only ~126 sources, while `apc_usd:null` matches ~17,900, and the pilot journal (Global Social Challenges Journal) itself carries `apc_usd: null`. DOAJ records an explicit has-APC flag for all ~23k of its journals (~14.6k are no-APC), so the rule in `DoajJournalDirectory::isDiamond` is: OpenAlex `apc_usd === 0` → diamond (`openalex_apc_0`); else DOAJ says no APC → diamond (`doaj_no_apc`); DOAJ says APC → not diamond; no DOAJ record → unknown, skipped by default (never claim diamond without evidence).

The full-registry sync reads DOAJ once via its CSV dump (`https://doaj.org/csv`, 307-redirects to signed S3); columns are read by header name and a missing APC column fails loudly rather than mis-parsing. The single-journal path uses the DOAJ API per ISSN. DOAJ's publisher/language fields also backfill journals where OpenAlex has nulls (common for small society journals).

## Commands

`php artisan journal:sync-registry --issn=2752-3349` — sync one journal by ISSN (the pilot path). Prints the diamond determination and the minted slug. Refuses to store a journal that is not provably diamond unless `--include-non-diamond`.

`php artisan journal:sync-registry` — full sync: OpenAlex `/sources` filtered `is_oa:true,is_in_doaj:true`, sorted most-cited-first, cross-checked against the DOAJ CSV. `--limit=500` keeps the most-cited N; `--topic=T10122` scopes to an OpenAlex topic; `--dry-run` counts without writing. Re-syncs refresh stats but never rewrite slugs.

`php artisan journal:list` — the worklist: registry ranked by `cited_by_count`, with works counts and `last_harvested_at`. `--all` includes non-diamond rows.

`php artisan journal:harvest <slug|S-id|ISSN> --max-works=25 --user=<admin username>` — the harvest itself, four inline stages: (1) enumerate all the journal's works via OpenAlex cursor paging (`primary_location.source.id` filter, `type:article` by default — `--type=` empty for all citable types), upsert them as canonicals via `CanonicalSourceMatcher::ingestExternal` (foundation_source `journal_harvest`) and stamp `journal_source_id`; (2) select eligible works most-cited-first (same predicate as the book-rooted harvester: no `auto_version_book`, OA, something fetchable); (3) per work, `AutoVersionCreator::create` — the whole existing ladder applies, JATS/HTML full text preferred (free) before PDF+OCR — with per-work try/catch so one bad PDF never kills the run; (4) add assigned books to the public `Journal: <name>` shelf (system creator) and merge run stats into the registry row.

`--dry-run` enumerates and reports eligibility without writing or fetching. `--skip-ocr` fetches without OCR. `--max-works` bounds the expensive stage — re-run to continue; every stage is idempotent, so Ctrl-C is always safe and a re-run resumes where it stopped. Long runs on big journals: run under tmux/nohup; the sliced-queue-job pattern (as used by `SourceNetworkHarvestJob`) is the upgrade path if unattended runs are ever needed.

## Billing and review

OCR is charged to the `--user` account after each successful import via `WorkOcrCharger` (the extracted, shared home of the set-BOTH-RLS-vars billing pattern — see its docblock; this half-copy has shipped broken twice). `assigned_existing` and failures are never charged; JATS/HTML lanes cost nothing. A run refuses to start OCR-charging work without `--user` (use `--skip-ocr`/`--dry-run` otherwise).

Imported books mint `visibility=public, listed=false` and flow through the standard review loop unchanged: `php artisan harvest:audit-imports --flag` to flag body-absent junk, review at `/maintainer/conversion`, approve to flip `listed=true` (`ReconvertQueue::promoteApprovedHarvest`) or retract (`HarvestRetraction`, which frees the canonical pointer for a re-harvest).

## Pilot recipe (GSCJ)

- `php artisan journal:sync-registry --issn=2752-3349` — expect S4387280908, diamond via `doaj_no_apc`, publisher Bristol University Press (DOAJ backfill), slug `global-social-challenges-journal`.
- `php artisan journal:harvest global-social-challenges-journal --dry-run` — ~107 works enumerated.
- `php artisan journal:harvest global-social-challenges-journal --max-works=5 --user=<you>` — small first batch; check conversions at `/maintainer/conversion` before going bigger.
- Re-run with larger `--max-works` until "journal fully harvested"; then `journal:list` for journal number two.

## The public journal pages (`/j`, `/j/{slug}`)

`JournalPageController` + `resources/views/journal.blade.php` / `journal-index.blade.php`: `/j` lists diamond journals ranked by citations; `/j/{slug}` renders the journal header and its works most-cited first, each linked to its best readable version via `BestVersionService::sqlCoalesceExpression` (one query, RLS-visible on the default connection). Linking rule: a visible version with content (`has_nodes`) links immediately and carries an *unreviewed* marker until reviewed (`listed=false`) — the page can't gate on `listed` because only FLAGGED books have an approval path; junk gets flagged → retracted → deleted, dropping off the page automatically.

Commons artifacts (journal shelves, commons harvest shelves) live under the system creator, so migration `2026_08_12_000003` seeds a real `canonicalizer_v1` users row (unloggable: random password, not admin) — without it every `/u/canonicalizer_v1/shelf/…` link 404s, a latent bug in the commons harvest flow that the first journal shelf exposed. Locked by `tests/Feature/SourceHarvest/CommonsShelfUrlTest.php`; the pages by `tests/Feature/JournalRegistry/JournalPageTest.php`.

## Follow-ups (deliberately not in v1)

- A per-journal yield-report book (`YieldReportBook` is root-book-keyed; console summary + shelf + `harvest_stats` cover v1).
- Bulk-approve for clean (unflagged, `verified_full`) imports once review volume demands it.
- A dedicated HTML scraper lane for HTML-native journals (the ladder already prefers JATS/HTML full text where it exists).

## Tests

`tests/Feature/JournalRegistry/JournalSyncRegistryTest.php` (diamond rule + provenance, CSV header contract, slug stability, limit/dry-run, ISSN path), `tests/Feature/JournalRegistry/JournalHarvestCommandTest.php` (cursor paging, stamping, citable-type gate, max-works cap, billing on `assigned` only, shelf + bookkeeping, no-user refusal), `tests/Feature/SourceHarvest/JournalEligibilityTest.php` (the journal-rooted predicate), `tests/Canonical/SourceNormaliserTest.php` (source normalisation). Test-writing note: seed admin-connection rows in `beforeEach` only — an `afterEach` admin delete deadlocks against the still-open RefreshDatabase transaction when the command has Eloquent-updated a committed row.
