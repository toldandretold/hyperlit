# Citation metadata: the publisher's page, and what the journal's own lifespan rules out

This module answers one question — *is the citation metadata we stored for this work actually right?* — and it answers it without asking a DOI registry, because for the case that motivated it the registry is the problem.

## The bug

`Christian Fuchs, "Co-operation and Self-Organization", tripleC 1(1)` imported as **1970**. It was published in **2003**. 112 of tripleC's ~1018 works carry the same year.

The instinct is to blame OpenAlex and re-derive from the DOI. That is wrong. `10.31269/triplec.v1i1.2` is deposited **at Crossref** as `issued: 1970-01-01` — the Unix epoch, a null date serialised as a real one somewhere in the publisher's deposit pipeline. OpenAlex copied it faithfully. Crossref, DataCite and DOI content negotiation would all hand back the same 1970, and it returns on every re-sync.

Two things know better, and we already had both on disk:

- **The article's own page.** tripleC runs OJS, which emits `<meta name="citation_date" content="2003">` alongside volume, issue, pages, authors, journal title and ISSN. We fetch that page during every import and stored it — then read four of its meta tags (`citation_pdf_url`, `citation_abstract`, `citation_title`, `citation_doi`) and discarded the rest.
- **The journal started in 2003.** An article dated before the journal existed is *impossible*, not merely suspicious — and that needs no second opinion at all.

## The pieces

### `PublisherPageMetadata`

The one citation-meta reader. Pulls the full Highwire / Dublin Core set out of a page, and finds the stored page on disk.

**Parsed with DOMDocument, scoped to `<head>`** — not matched with a regex. A regex over raw HTML cannot tell a live tag from one inside an HTML comment or a `<script>` template, and cannot tell the page's own citation tags from a "related articles" widget embedding a different work's. The parser skips comments and script contents by construction, and meta belongs in the head, so the widget case *disappears* rather than being defended against. It falls back to the whole document only when the head carries no meta at all. Switching from regex to DOM changed the outcome on **zero** of 213 real stored pages — it is purely a robustness upgrade, and the tags themselves are a deliberate machine-readable standard (Google Scholar and Zotero read the same ones), not prose being guessed at.

**"There isn't one yet" is not a value.** `isPlausibleDesignator()` rejects the placeholder vocabulary publishers really use — a corpus audit found Bristol UP emitting `citation_volume: -1` and `citation_issue: aop` on an ahead-of-print article, and a naive gap-fill would have put `volume = -1` on the card. It rejects negatives, zeroes and the placeholder words while keeping messily-real designators (`12A`, `Suppl 1`, `Part 2`): demanding digits would throw away good data. An honest gap self-heals on the next sync; a stored `-1` looks deliberate forever.

The filename list is load-bearing. `fetched_page.html` is written only by the HTML lane's **success** path; a PDF-lane import saves the *same landing page* as `original.html` before deciding the page is abstract-only and downloading the PDF instead. The repair only ever looked for `fetched_page.html`, so every PDF-lane work reported "no stored page" while its page sat right there — which is exactly how the tripleC article stayed at 1970 despite a tool existing to fix it. `PAGE_FILENAMES` tries all four names, unambiguous ones first.

### `JournalYearFloor`

"Could this journal possibly have published in year N?" — backed by `journal_sources.first_year`.

The subtlety is which year gets stored. DOAJ's `bibjson.oa_start` is when the journal went **open access**, which for a journal that converted later is well after its founding year; trusting it alone would declare genuinely old articles impossible and "repair" them into wrongness. So the floor is the **earlier** of `oa_start` and the oldest non-sentinel year we have actually observed among the journal's own works — evidence we hold always beats a registry's claim, so the floor can never reject an article we have real grounds to believe in.

Sentinel exclusion when deriving from observed works is not optional: include 1970 and tripleC's floor becomes 1970, the gate passes every corrupt row, and the detector silently does nothing.

The floor answers **impossible**, never **correct**. A year that is merely early is invisible to it — which is why the publisher page is consulted too.

### `MetadataDriftDetector`

**First, the page has to prove it is this work.** `storedPageFor()` returns whatever HTML is in the book's directory, and not all of it is a verified landing page for that article: `rejected_page.html` is written by three gates, and the **engine-crash** one fires *before* `assessArticleAuthenticity` runs, so that page's identity was never checked by anyone; and `original.html` is the publisher landing page for a PDF/legacy fetch but the rendered **ar5iv article** for the ar5iv lane. `identityMatches()` requires a DOI match, or failing that a title similarity ≥ 0.7 — and **no corroboration at all is a refusal, not a pass**. Without it, another article's page carrying a plausible date could turn an obviously-ugly 1970 into a *confidently wrong* year, which is strictly worse: nothing downstream can see it.

Then it compares stored against page, and splits the outcome deliberately:

- **Corrects silently** only where the stored value is provably broken — an epoch sentinel, a year before the journal existed, or an empty column. 1970 for a journal founded in 2003 is not a competing opinion.
- **Flags and touches nothing** where both values are plausible and merely differ (page says 2004, OpenAlex says 2005). Preferring the page there would trade a known bug for an unknown one. The page is not automatically the better source for every field.
- **Rejects the page** when the page's own year fails the same plausibility gate — otherwise a junk page could "fix" a good year into a bad one.

Volume and issue only ever **fill** an empty column. The year is the one field with positive evidence of breakage; a publisher page's volume string is not obviously better than one already stored.

**Nothing is ever rewritten invisibly.** A flag is raised whenever anything moved *or* is contested, not only for disputes — an automatic correction is still a machine rewriting a citation from a scraped page, so it leaves a reviewable, reversible record. `details.needs_decision` separates "you must choose" from "here is what was changed for you", and the console badge renders them differently. Without it, the only trace of a silent fix is a log line nobody reads, and *"the card says 2003 now and I don't know who decided that"* is its own integrity problem.

Writes go through `PublisherYearRepair::apply()` — canonical + **every** library version row + `LibraryCardGenerator::patchBibtexFields`. The bibtex patch is mandatory, not cosmetic: cards render stored bibtex **in preference to** the structured columns, so fixing only the column leaves the visible citation wrong.

## Where it runs

- **At import**, after the lane lands — `HtmlLaneCreator` and `AutoVersionCreator` both call `inspect()`. It runs *after* the fetch because the fetch is what puts the page on disk, so the check costs no extra request. It is wrapped: a metadata disagreement must never fail an import whose content already saved.
- **As a repair** — `php artisan library:repair-metadata` (`library:repair-years` is kept as an alias). Default run is free, offline and repeatable; `--fetch` is opt-in for works whose page we never kept, and uses the PLAIN rung only so a metadata pass can never spend OCR money.
- **In the maintainer consoles** — disputes become a `metadata_drift` flag on `conversion_flags`, which `BuildsImportLanes` already surfaces in both `/maintainer/journal-import` and `/maintainer/shelf-import`, with the existing resolve/dismiss buttons closing it.

## Two traps

**A metadata flag must never trigger a re-OCR.** `ReconvertQueue` selected *every* open flag regardless of source, so introducing any new flag kind silently enrolled its books for re-conversion. On this corpus that would have queued 112 tripleC books for re-OCR over a wrong year, at real money. The fence is `ConversionFlag::CONVERSION_SOURCES` — an allow-list, so the next new flag kind is opt-in rather than opt-out.

**A year change is invisible until the shelf renders are dropped.** Feeds are cached as `shelf_{id}_{sort}` synthetic books in `nodes` and nothing else invalidates them. Re-run `php artisan journal:harvest <slug> --max-works=0` after a repair; the command prints this reminder.

## Deliberately not here

Crossref / DataCite / CSL content negotiation, per-field provenance, and a day-precision `date` column were all considered and deferred. Crossref is the *source* of the bad data in this case, and none of that machinery was justified by a failure mode nobody had sized. The `metadata_drift` flags are the evidence that would justify it: if disputes start showing failure modes the publisher page cannot settle, a registry rung earns its place then.

## Tests

`tests/Canonical/MetadataDriftTest.php` (`php artisan test --testsuite=Canonical`) — the extractor, the floor's `min()` reconciliation, the correct-vs-flag split, and both sides of the reconvert-queue fence. `tests/Canonical/PublisherYearRepairTest.php` still locks the write path.
