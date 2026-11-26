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

## Notes stay printed at the foot of the text

The EPUB lane removes every footnote definition from the body once it is extracted (`DefinitionElementRemover`) — the note lives in the tap-to-open container. For this site that left a bare "Notes" heading over nothing at the end of every letter, where a reader expects the notes. So the stitcher writes `<meta name="hyperlit:keep-notes" content="true"/>` into the EPUB's package file, the normaliser reads it (`keep_notes`; the stitcher's `marxists_provenance.json` beside an older EPUB counts too, so a plain reconvert fixes books stitched before the flag), and the remover instead reprints each note where it stood, from its EXTRACTED content, as plain text under the book-wide number its marker shows (`[5] Mitya—the pet name…`). Not the source's number: those restart every chapter. Not a `sup[fn-count-id]`: that would be counted and renumbered as a second marker. Each kept block carries `role="doc-footnote"` (one of the few attributes the normaliser's sanitiser passes), which is how the bibliography scan knows to skip it — an editorial note that opens with a name and a year ("Ulyanova, Maria Ilyinichna (1878-1937)—…") is entry-shaped, and three of one letter's seven notes were minted as references before that. The flag is opt-in per source; every other EPUB converts as before.

## A note is wherever its marker points (2026-11-26)

The first lint of the prod shelf found 662 dead `[1]` links in 21 books (344 in the Grundrisse alone). Every detector recognised a definition by its SHAPE, and the site prints a dozen: an empty id anchor inside `span.term` then `1.` (Grundrisse); an empty anchor beside a `(1)` backlink (Marx's doctoral thesis); a plain `<span class="term">2</span>` reached from a marker typed `2]` (The Bakuninists at Work); a reciprocal pair under `<h1>Notes</h1>` (Palmerston). `HeuristicFootnoteDetector` pattern 7 needs no shape: a marker-text link points at an anchor that OPENS another block, and that block opens with the SAME marker. It refuses a target mid-paragraph, a block that opens with prose or a different number, a definition's own backlink (it points backward at a link; a note standing before its marker is reached at an empty anchor), and a verse number (a classed number link, or one that links somewhere else that exists — a study Bible fixture lost two verses before that guard).

Four more causes from the same sweep, all in the normaliser, so a plain reconvert of an existing book picks them up:

- **Lenin's sidebar notes.** The Collected Works pages print an author's footnote inside the paragraph, right after its marker (`span.footnote-as-sidebar`), and leave "Note: This footnote has been moved into the body of the document." where it stood. `_lift_sidebar_notes` makes each one a paragraph after the one it sat in and drops the placeholder.
- **A backlink's landing spot is not a definition.** `<a id="1.1"></a>` in the body, linked only from the note below it, was read by the empty-anchor scheme as a definition, and the body paragraphs after it became "the note" (Left-Wing Communism: 53 of 70 notes orphaned). An empty anchor linked only from below is skipped.
- **Two ids on one note.** The one-element-one-definition dedup dropped whichever id registered second; markers pointing at it orphaned. The dropped id is now an alias (`alias_ids` → `ctx.id_aliases`).
- **A note cited twice.** The heuristic's markers were deduplicated by TARGET, so a second reference to the same note stayed a dead link (Anti-Dühring). They are deduplicated by link.

The second lint, after reconverting (45 dead links in 8 books, 41 orphaned notes in 7), added three more:

- **The anchor stands just before the note, not in it.** Between two paragraphs (`<a id="fn06"> </a><p><span class="term">6.</span> …`, the 1844 Manuscripts), closing the previous note, or inside the "Footnotes" heading (On Afghanistan). An empty anchor with nothing printed between it and the next block identifies that block, under the same same-marker test.
- **The anchor follows the printed number.** `<span class="term">135</span><a id="135"></a> The March Association…` (The Campaign for the German Imperial Constitution): the number is all that precedes the anchor.
- **An editor's note cited from inside an author's footnote** ("…in Schmollers Jahrbuch,[29] 1896.—Lenin"; What Is To Be Done?, Two Tactics, The Heritage We Renounce). A marker inside a definition was always excluded as a backlink. `NoterefConverter` now links it when it points at ANOTHER definition that nothing in the body cites, and only where notes stay printed in the text; the host note's content is re-extracted so the reprinted note carries the marker.

**Ordinary links (contents entries, "see section 3").** The stitcher rewrites a link to another page of the same work into an in-book `#pNNN-id` link and a link to any other work into its absolute marxists.org URL. The in-book ones went dead when their landing anchor stood BETWEEN blocks (`</p><a id="s3"></a><h5>Third Observation</h5>`): a book is one node per block, so the loose anchor became an empty node with no id. `seat_loose_link_targets` (end of the EPUB normaliser) moves each still-linked loose anchor into the block it precedes (Grundrisse 34 dead of 297 → 0; Left-Wing Communism's appendix contents 6 → 0). The lint's `dead_internal_link` detector reports any in-page link whose target is in no node of the book.

**Third lint (2026-11-26), three more causes, all general.**

- **A starred note that prints no marker of its own** (Letters of Marx and Engels): `…the death of Brown<a href="#note"><b>*</b></a>…`, then after the signature `<a id="note"></a><p class="information">BROWN, JOHN (1800-59)…`. A star is never a contents entry, so a star pointing forward at an anchor that stands just before a block needs no opening marker to vouch for it. A bracketed star (`[*]`) is now a marker at all.
- **A note's own backlink read as a marker** (Capital, chapter 1): the backlink "A." returns to an empty anchor closing a body paragraph, and the next paragraph opens "A thing can be a use value…" — so that paragraph left the text as note [A]. A link that OPENS its own block and points backward is that block's backlink.
- **`<caption>` was not an allowed tag**, so every table caption was deleted with whatever it held, including two of Capital's note markers. Allowed in all three sanitiser lists.

**Reading this shelf's lint.** After those, what the lint still lists for a marxists.org work is mostly the source's own layout, and it now says so: see `docs/maintainer-loop.md` §"Three things a finding can be". Use the `src` verdict for the two kinds below.

Still not handled: markers whose target id does not exist in the source (Left-Wing Communism's `[30]` points at a backlink id), and a stray character before a note's marker (`((1)`, `"[2]`), one each in the doctoral thesis and One Step Forward. The shelf's `split_sentence` findings are the source's own layout: a display quotation inside a sentence is three `<p>`s on the page (Anti-Dühring).

## The bulk import (a whole author, from the backend)

For the maintainer: list an author's works, then import them a batch at a time into the **marxists.org archive** (`/a/marxists-org`), reviewed in `/maintainer/shelf-import/marxists-org` like any other imported collection.

- `php artisan marxists:list <author>` — reads the author's listing page (`stitch.py list`) and records one row per WORK in the `marxists_works` ledger. Imports nothing; one polite request for most authors, one per year page for the Marx/Engels archive. `--dry-run` to look first. Authors and their listing pages are in `MarxistsArchive::AUTHORS` (marx, lenin, trotsky, luxemburg, clr-james).
- **Selected Works.** Where marxists.org has a Selected Works page for the author (`selected` in `MarxistsArchive::AUTHORS`: Lenin's `/works/sw/index.htm`, 37 works of about 3,400; the Marx/Engels one; Trotsky's `/works/sw.htm`, 10 links of which 5 are subject collections), `marxists:list` reads it too and flags those ledger rows `selected`. That is the editors' own choice of what matters, so `marxists:import <author> --selected` is the sensible first pass instead of every letter and telegram. Only a work the author's own listing already found is flagged, matched by address: a Selected Works page also links single chapters and prefaces (Marx's links "Capital, Chapter One" and the letters index), and those are printed as "not flagged" for a person to look at, never added as works. Luxemburg and C. L. R. James have no such page (checked on their index pages, 2026-11-24). A selected page that cannot be read fails only the flagging; run `marxists:list` again later.
- `php artisan marxists:import <author> --limit=10` — claims the next batch of listed works and queues `ImportMarxistsWorkJob` for each. `--selected` takes only the Selected Works (and any batch takes selected works before the rest); `--kind=work_folder` takes the multi-page works first; `--retry-failed` requeues hiccups; `--now` runs the batch in the terminal; `--dry-run` shows it.
- `php artisan marxists:status [author]` — counts per status, how many imported books have finished converting, and what failed or was refused.

**How a listing becomes works** (`Lister`): MIA files a short piece at `/<year>/<month>/<file>.htm` and a longer work in its own folder `/<year>/<slug>/` with a contents page, and a listing links the contents page AND often the chapters (Lenin's by-date page: 4,189 links for ~3,400 works). So a dated file is a work; a folder whose index is linked is ONE work (its chapters dropped); a folder with no index linked (MIA's "misc") gives one work per file; `/<year>/index.htm` is read — a year LISTING is followed one level, a work filed straight under a year (Capital, `/1867-c1/`) is a work; an undated `…/index.htm` is a candidate settled at import (a subject collection is refused as `not_a_single_work`); biography, quotes, images and the by-title / collected-works listings are skipped. Measured 2026-11-23: Luxemburg 84 works, C. L. R. James 348, Trotsky 686, Lenin 3,394 (mostly letters), Marx/Engels 487 (63 requests: the listing plus 62 year pages). Year pages link each other (previous / next), so each is fetched ONCE and settled once — re-reading every such link ran the Marx/Engels listing past its 150-page cap on prod (`too_many_pages`, 2026-11-24) — and a folder that is exactly a year (`/1838/`) is always a listing however few works it holds; only a year-shaped folder with more to its name (`/1867-c1/`) can be a work.

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
