# Importing from marxists.org

Paste the contents page of ONE work on the Marxists Internet Archive into the "import from a link" box (or pass it to MCP `import_document` as `url`), and the server crawls the work's pages, stitches them into one EPUB and converts it — the same paste-a-link flow as Project Gutenberg. One work = one book, crediting the work's contents page. Built 2026-11-23; the recon that preceded it is `ignore/marxists-recon/` (its `FINDINGS.md` has the per-work numbers).

## The shape of it

- **Identifier** — `MarxistsId` (`IdentifierNormalizer::tryMarxists`): any `marxists.org/….htm` page, or a folder (its `index.htm`). Host-anchored; a file download or a traversal path is not one.
- **Preview** (`POST /import-url/inspect`) — `MarxistsMetadataResolver` runs `stitch.py metadata <url>`: ONE page fetched. Title, the page's author credit, year, language and the licence come off the work's own page. Cached 15 minutes, because the UI inspects and then commit re-resolves, and each resolve is a request to a volunteer-run site.
- **Commit** (`POST /import-url`) — the library row is written at once (so the book exists and the progress card has something to poll), the author is linked, and `StitchMarxistsWorkJob` is queued. **Nothing is crawled inside the request**: the crawl waits ~1.5s between pages, so a 47-page Capital is over a minute.
- **The job** — `MarxistsWorkFetcher` → `stitch.py build <url> <dir>` writes `original.epub` + `marxists_provenance.json`, then dispatches `ProcessDocumentImportJob` exactly as an uploaded EPUB would be. Both hops ride the interactive `imports` lane (`tests/Feature/Import/ImportQueuePriorityTest.php`).
- **The book belongs to whoever imported it**, like a Gutenberg import, and is born public. A maintainer's import of a whole author is the bulk import below, which differs on purpose.

## Why an EPUB

The site's footnotes come in half a dozen shapes, and the EPUB pipeline already has detectors for the commonest (`EnoteFootnoteDetector`). So the stitcher writes no footnote parser: it cleans each page, rewrites the other note shapes into `sup.enote`, namespaces the ids, and packs the pages as a real EPUB (`mimetype` first and stored). From there it is an ordinary EPUB import — images included, via the pipeline's `ImageProcessor`. MIA's own EPUB downloads are not used: they lose the per-page source URLs and are not offered for every work.

## What the site throws at a crawler (each one broke something first)

- **Contents are marked at least four ways**: `p.index`, blocks after a "Contents" label, `table.t2h-toc` / `span.toc`, or nothing at all (a single-page work).
- **Footers carry navigation that looks like contents** (prev / next / archive index) — stripped before anything is read.
- **Related works sit right under the contents.** Only EXPLICIT contents markup may leave the work's folder (the Brumaire's 1885 preface lives elsewhere); looser blocks stay in-folder; another work's contents page is never expanded.
- **A single-page text's folder holds alternate translations** — a page that is itself prose never crawls its siblings.
- **A contents entry can itself be a contents page** (Capital's `part0.htm`) — expanded, in-folder only.
- **Notes can live on a shared page** (`notes.htm`, the MECW editorial notes) — any in-folder page the text links INTO with a fragment is appended.
- **Note ids restart every chapter** (`id="1"`, `"1b"`) while the EPUB pipeline flattens the spine — so every id is namespaced by its page.
- **Three marker styles in one work.** What they share is reciprocity (the reference and the definition point at each other) → rewritten to `sup.enote`. Capital also has one-way pairs (bare refs, or a back-link to an anchor that does not exist) → a marker-text link pointing FORWARD at an anchor that opens its block and reads as a note number.
- **Thumbnails link the real image** — the full-size file is taken; a missing one falls back to the thumbnail. Some "images" are statistical tables (Luxemburg), so dropping them loses content.
- **Encoding**: pages declare iso-8859-1 and mean cp1252.
- **An author index or a Collected Works volume is a list of works**, not a work. Refused (`not_a_single_work`) — by address where recognisable, before any fetch.

## Politeness and safety

Sequential, `MIN_DELAY` 1.5s between requests, an identifying User-Agent (`sam@hyperlit.io`), each URL fetched once per run, hard caps (`MAX_PAGES` 200, `MAX_IMAGES` 300, 8 MB an image). Only marxists.org is ever contacted: a page cannot point the crawler at another host, and a redirect off the site is not followed. TLS is verified against certifi's bundle when it is installed — a python.org macOS build wires no system CA bundle to urllib, and with the default context every request failed verification and every page read as "unavailable" (found by the first live run).

## Licence

The page's information block is the only evidence used: `Copyleft: … Creative Commons ShareAlike` → `CC-BY-SA-2.0` (MIA's `admin/legal/cc/by-sa.htm` IS 2.0) with that terms link; `Public Domain: …` → `PDM`; silence → `Unknown`, never a guess. Silence is common on the Marx/Engels archive: those are often Progress Publishers / MECW translations whose rights MIA does not state (Lawrence & Wishart had MECW material removed in 2014). The resolver hands the CODE over (`license_code`), and `UrlImportController::statedLicense` stores it — there is no free-text licence string to infer from.

## Authors

`App\Services\Authors\MarxistsAuthors` reads the page's own author credit through a fixed, checked map (name → author slug + Wikidata QID) and links the book (`book_authors.source = 'import'`), so it is on `/a/marx` as soon as it has content. The credit, NOT the archive folder: Engels' works sit under `/archive/marx/`. All or nothing — a joint work with one unknown author links nobody. The map is ours, which is why this links for ANY importer (a drop-folder manifest's `authors` is caller-supplied and admin-only). An author outside the map still imports; the book is just unlinked. See `docs/authors.md`.

## Two pipeline bugs this lane exposed (both fixed, both general)

- **`InlineAnchorNoteFootnoteDetector` scrambled prose.** It is for an empty `<a id=X></a>` standing BEFORE the note's block. MIA's MECW notes put that anchor INSIDE the note's paragraph (`<p><a id="n5"></a><strong>5.</strong> The <em>German People's Party</em>, established…`). `find_next_siblings()` returns only elements, so the "following block" it gathered was the sentence's own `<em>`/`<strong>`/`<a>` — lifted into a wrapper, leaving "The , established…". It ran AFTER another detector had already claimed the note, and mutated the DOM before the dedup dropped its duplicate, so every count stayed clean. It now leaves an anchor inside running text alone (`_is_inline_in_prose`).
- **A definition's own printed number stayed in the note** when it was wrapped (`<span class="info"><a>1.</a></span>`), bracketed (`[1]`, `(1)`), or bold and unlinked after the id target (`<a id></a><strong>5.</strong>`). The number is the SOURCE's, restarting every chapter, so it contradicted the book-wide number on the marker the reader tapped. `strip_leading_footnote_number` handles all of them; bold prose and a bold year are left alone.

A third, in `FootnoteBlocks` (every EPUB-lane footnote opened on an empty line: the definition anchor became a node of its own), is covered in `tests/Unit/FootnoteBlocksTest.php`.

## The bulk import (a whole author, from the backend)

For the maintainer: list an author's works, then import them a batch at a time into the **marxists.org archive** (`/a/marxists-org`), reviewed in `/maintainer/shelf-import/marxists-org` like any other imported collection.

- `php artisan marxists:list <author>` — reads the author's listing page (`stitch.py list`) and records one row per WORK in the `marxists_works` ledger. Imports nothing; one polite request for most authors, one per year page for the Marx/Engels archive. `--dry-run` to look first. Authors and their listing pages are in `MarxistsArchive::AUTHORS` (marx, lenin, trotsky, luxemburg, clr-james).
- `php artisan marxists:import <author> --limit=10` — claims the next batch of listed works and queues `ImportMarxistsWorkJob` for each. `--kind=work_folder` takes the multi-page works first; `--retry-failed` requeues hiccups; `--now` runs the batch in the terminal; `--dry-run` shows it.
- `php artisan marxists:status [author]` — counts per status, how many imported books have finished converting, and what failed or was refused.

**How a listing becomes works** (`Lister`): MIA files a short piece at `/<year>/<month>/<file>.htm` and a longer work in its own folder `/<year>/<slug>/` with a contents page, and a listing links the contents page AND often the chapters (Lenin's by-date page: 4,189 links for ~3,400 works). So a dated file is a work; a folder whose index is linked is ONE work (its chapters dropped); a folder with no index linked (MIA's "misc") gives one work per file; `/<year>/index.htm` is read — a year LISTING is followed one level, a work filed straight under a year (Capital, `/1867-c1/`) is a work; an undated `…/index.htm` is a candidate settled at import (a subject collection is refused as `not_a_single_work`); biography, quotes, images and the by-title / collected-works listings are skipped. Measured 2026-11-23: Luxemburg 84 works, C. L. R. James 348, Trotsky 686, Lenin 3,394 (mostly letters), Marx/Engels 182 before its year pages.

**How a bulk-imported book differs from a pasted link**, all on purpose (`MarxistsBulkImporter`):

- **Owned by the system account**, not whoever ran the command — nobody "contributed" it, so author pages show "Texts from marxists.org" and no contributor.
- **Born public but unlisted**, like the harvested journal corpus: on the archive page, the author pages and their searches, not in the homepage feeds or homepage search until reviewed.
- **On the `default` queue**, both the crawl and the conversion — a person's upload never waits behind it (`ImportQueuePriorityTest`).
- **Public whatever licence the page states, including none** ("Licence unknown") — user decision 2026-11-23: the text is openly published on marxists.org and every copy links back to its page. `HostingPolicy` agrees (Unknown is withheld only for saved web evidence). The daily licence discovery will still look these rows up; if it ever stamps one all-rights-reserved, the hosting policy would hide it.
- **The EPUB is stitched BEFORE the library row exists**, so a failed crawl leaves no empty public book.
- **A page with no title of its own beyond what it IS** ("Afterword") takes the listing's fuller link text; a page with no date takes the year it is filed under.
- **The author** comes from the page's credit; in a one-author archive a page with no credit gets the listing's author. The Marx/Engels archive has no such default — it holds two people's works under one folder.

**Other versions.** A work already imported from the same contents page is never imported twice (`exists`). A DIFFERENT edition of the same work (the Penguin Capital beside marxists.org's) is still imported — it is a different text — and the ledger records it (`same_title_as`, matched on the main title among that author's linked books), so the maintainer can see which works now have several versions. Nothing yet stops an author page's search returning the same passage from each version: see "Not built".

## Not built

- **Grouping an author page's search by WORK.** With several versions of Capital linked to Marx, a semantic search returns near-identical passages from each. `SearchService::diversifyByBook` caps one BOOK's share and does not know two books are one work.
- **Translators as author links** — the information block names them in free text with no id.
- **Non-English sections** work (the German Manifesto converts with `language: de`) but have had one test work; the bulk listings are the English archives.
- **Adding a pasted-link import to the marxists.org archive shelf** — those books are their importer's; only the bulk import files onto the archive.

## Tests

- `tests/conversion/unit/test_marxists_stitch.py` (pytest) — the stitcher against a synthetic site held in memory: every trap above, the refusals, the EPUB's shape, and one END-TO-END case that runs the stitched EPUB through the real `epub_normalizer.py` + `process_document.py` and asserts every note is linked with its number stripped.
- `tests/Feature/Api/MarxistsImportTest.php` — both lanes with the process faked: inspect, the cache, refusals carrying their reason, commit (row, licence, author link, the queued job), the job's hand-off and its failure, duplicates; and the bulk import (listing into the ledger, the system-owned unlisted public book, Unknown licence staying public, no assumed author on the Marx/Engels archive, refusals and failures leaving no book, other versions, batch claiming on the `default` lane).
- `tests/Unit/SourceImport/IdentifierNormalizerTest.php` (marxists cases), `tests/Feature/Import/ImportQueuePriorityTest.php` (both hops on the interactive lane), `tests/conversion/unit/test_epub_detectors.py` + `test_footnote_link_rules.py` (the two pipeline fixes).
- Nothing in the suites touches the network. Live check: `python3 app/Python/ingestion/marxists/stitch.py metadata <url>`, then paste a small work's URL into the import box.
