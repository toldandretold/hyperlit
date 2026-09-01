# Web-scrape imports: the drop-folder standard and the archive workflow

Per-site scrapers are custom — a link-list of PDFs (ris.org.in), a publisher's article pages, a text shattered across many HTML files (marxists.org someday) are different pipelines, and pretending one scraper config covers them is how you get a tool that fights every new site. What IS standard is the OUTPUT contract: a scraper emits a **drop folder** — the documents plus a `manifest.json` — and from there everything is existing machinery: drag the folder into Hyperlit, each file becomes a book with correct bibliographic metadata and source-URL provenance, the batch appends to a shelf, the shelf is reviewed lane-by-lane in `/maintainer/shelf-import`, and the finished collection gets a public hero page at `/a/{slug}`. The first living example is `php artisan scrape:ris-docs` (`app/Console/Commands/Scrape/RisDocsScrapeCommand.php`), which scrapes the Non-Aligned Movement documents off ris.org.in.

## The drop-folder contract

One folder per scrape run. Documents in `md`, `html` or `pdf` (plus images referenced by md files, which ride along Obsidian-style — `resources/js/components/importQueue/folderIngest.ts` routes them by reference). A `manifest.json` at the folder ROOT — a manifest in a subfolder is ignored, and the manifest itself can never become a book (`json` is not an importable extension). Files the manifest doesn't mention still import, with filename-derived titles; manifest entries with no matching file are logged (verbose) as the scraper-bug signal. Caps: the drop traversal reads at most 300 files (depth 12) and a batch registers at most 100 items — split bigger scrapes into multiple drops. Gotcha: name HTML files `.html`, not `.htm` — the upload allowlist (`ImportController.php`) accepts only the long form.

## manifest.json reference

Top level: `schema_version` (currently `1`), a `source` block (`site`, `scraper`, `page`, `scraped_at` — provenance breadcrumbs, recorded in each book's `raw_json`), and `documents` — a map keyed by each file's path relative to the folder root (a bare basename also matches, but an exact relPath entry wins).

Per-document fields, each mapping 1:1 onto a `POST /import-file` request field that is written to the `library` row: `title`, `author`, `year`, `url`, `publisher`, `journal`, `type`, `language`, `note`, `bibtex`, `volume`, `issue`, `pages`, `booktitle`, `chapter`, `editor`, `school`. Unknown keys are stripped client-side at parse time and whitelisted again in `batchUploader.ts` — they never reach the server. `doi` is deliberately reserved (canonical-source matching has side effects; it can ride `bibtex` or `note` for now).

These fields are AUTHORITATIVE: request fields land on `library` before the conversion job runs, and the pipeline's own metadata extraction (`updateLibraryMetadata`) only fills blanks. That is the whole point of the manifest — it sidesteps the empty PDF extractor, the weak HTML `<meta>` reader, and the frontmatter-beaten-by-filename problem in one move.

```json
{
  "schema_version": 1,
  "source": { "site": "ris.org.in", "scraper": "scrape:ris-docs --section=NAM", "page": "https://www.ris.org.in/en/documents-non-aligned-movement", "scraped_at": "2026-09-01T08:00:00Z" },
  "documents": {
    "nam-19th-summit-kampala.pdf": { "title": "NAM-19th Summit 19–20 January 2024 Kampala, Uganda", "url": "https://www.ris.org.in/Others/NAM-Summit-19-Kampala-Uganda-19-20Jan%202024-Declaration.pdf", "year": 2024, "language": "en" }
  }
}
```

## Choosing a format per document

- **`md`** — the cleanest conversion path (`simple_md_to_html.py` → the full pipeline). One hard rule: do NOT emit YAML frontmatter — it is never stripped and renders as book content (the `---` fence becomes an `<hr>` and the fields become paragraphs). All metadata goes in the manifest.
- **`html`** — goes through HTMLPurifier sanitization and the conversion pipeline; good for publisher article pages. Strip site chrome (nav, footers, sidebars) in the scraper — the pipeline converts what you give it.
- **`pdf`** — the fallback when no text source exists; costs OCR (Mistral, billed) and archival scans will stress it, so expect the reconvert loop to be where the time goes.

## Provenance

`url` is the document's source URL and lands in `library.url` — the book's source link. Everything else posted with the file — every manifest field plus `imported_via=scrape-folder`, `manifest_schema_version` and `scrape_site` — is preserved verbatim in `library.raw_json` (`ImportController` stores the whole request). Books dropped by an admin are owned by that admin even when the target shelf is system-owned; that split is intended (the shelf curates, the importer owns).

## The shelf workflow

The archive IS a shelf; two ways to feed it.

- **Bootstrap**: drop the scrape folder anywhere the SPA drop target lives (home page, your user page). A multi-file drop auto-creates a PRIVATE shelf named after the folder (find-or-create by name, so a same-named folder appends). Flip the shelf public via the globe toggle in its shelf header on your user page — the shelf-import console and the public archive page both require a public shelf.
- **Top-up (the standing loop)**: open `/maintainer/shelf-import/{shelf-uuid}` and drop the folder ON the console — every drop there (even a single PDF) imports as a batch that appends to THAT shelf, via an explicit `shelf_id` the server authorizes (admin or shelf owner — the completion-time append runs BYPASSRLS, so `ImportBatchController::store` is the security gate). A status line tracks the batch and the articles pane reloads when it settles; dropped books appear as standalone (canonical-less) articles for lane-by-lane review, reconvert, flags, and the bad-conversion download loop.

## The public archive page (/a/{slug})

The console's **archive page** panel (shelf detail header) writes the `archive_sources` registry row: a globally-unique slug, a display name, and hand-written about copy you paste straight into the textarea (paragraphs separated by a blank line; the first renders large). Saving gives the shelf a hero page at `/a/{slug}` — the journal-page design (lava-lamp hero, shelf-scoped search, Most Recent / Most Connected / Most Lit tabs driving the public shelf render endpoint) minus the journal registry machinery. The ★ **certify** toggle is the human signal that lists the archive on the homepage under the certified journals; the listing needs certified AND ≥1 readable document, so an archive that loses its books self-heals off the homepage without anyone un-certifying it (`App\Services\Archives\CertifiedArchivesQuery`). `/a` itself lists the same slice. The `a` path segment is reserved in `config/reserved-routes.php`.

`/a/{slug}` participates in SPA navigation through the shared prefix classifier `nonBookPrefixStructure` in `resources/js/SPA/navigation/utils/structureDetection.ts` — the SINGLE place URL prefixes are taught to the history machinery. Any future public prefix page must be added there (and only there); the launch bug this encodes was `/a/{slug}` being read as "a book named `a`", with popstate rewriting the history entry down to `/a`. Pinned by `tests/javascript/SPA/navigation/urlStructure.test.js` (CI) and the archive variant of `tests/e2e/specs/journal/journal-spa-navigation.spec.js` (manual e2e).

## Scraper conventions

Scrapers live in `app/Console/Commands/Scrape/` as artisan commands, one per site (or per site-shape). Be polite: sequential downloads, a delay flag, a real User-Agent, operator-run — never a crawler. Emit stable slugified filenames so re-runs skip already-downloaded files and the same folder can be re-dropped to top up (`shelf_items` dedupes by primary key). Record `scraped_at` and the page URL in the manifest's `source` block. If a host is hostile to plain HTTP, the SourceHarvest fetch ladder (stealth Playwright, FlareSolverr) exists — but don't wire it in until a real site needs it.

## Follow-ups (deliberately not in v1)

`doi` as a manifest field (needs a decision about canonical-source linking for archive documents). A shelf-scoped hypercite network SVG on `/a/{slug}` (`JournalHyperciteMap` is journal-scoped; archives start with zero hypercites). Multi-page HTML stitching for marxists.org-shaped sources — a different scraper pipeline whose output should still be this same drop-folder contract. Sitemap entries for `/a` pages (the `/j` pages share this gap).

## Tests

`tests/Feature/Api/ImportBatchTest.php` locks the explicit `shelf_id` authorization (admin / owner / stranger-404 / auto_shelf-exclusivity). `tests/Feature/Api/ArchiveSourcesTest.php` locks the `/a` pages, the homepage's certified slice and its self-healing readable floor, and the console archive endpoints. `tests/javascript/components/folderIngest.test.js` locks manifest parsing (relPath + basename keys, forced batch for single files, malformed-manifest tolerance, unknown-key stripping); `tests/javascript/components/batchUploader.test.js` locks the wire format (shelf_id in the register POST, whitelisted metadata + provenance breadcrumbs in the file POST). All in `npm run test:run` except the PHP pair (`php artisan test`).
