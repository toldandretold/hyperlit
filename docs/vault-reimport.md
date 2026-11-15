# Importing a vault: the folder's own metadata, and books already in Hyperlit

A shelf downloads as a Markdown / Obsidian vault (`MarkdownVaultBuilder`), and a dropped folder of `.md` files imports as a shelf (`folderIngest.ts` → `batchUploader.ts`). This doc covers what happens when the dropped folder already KNOWS things: its notes carry YAML front matter, it holds a `.bib` file, or it is a vault that came out of Hyperlit in the first place.

## What was wrong

Dropping an exported vault back in produced a shelf of strangers. Every library row had the FILENAME for a title ("Kay Gabriel - Abolition as Method") and nothing else — no author, year, DOI or licence. The front matter went through the markdown converter as content, so each book opened with an `<hr>` and a column of `title: "…"` paragraphs. `references.bib` was dropped by the extension filter without a word. The generated `README.md` became a book called "README". And every note became a brand-new private copy, so the hypercites between them — exported as footnote links to `https://hyperlit.io/{book}#hypercite_x` — pointed at books that were no longer the ones on the shelf.

One of the causes was older than the feature: `ProcessDocumentImportJob::updateLibraryMetadata` read the library row on the RLS connection from a queue worker, where no session vars are set and `library_select_policy` hides a private row. Every import is born private, so the method returned at its null check and had never filled a field. It reads and writes on `pgsql_admin` now.

## Part 1 — metadata from the folder

**Per field, the precedence is `manifest.json` > the note's front matter > the folder's `.bib` entry.** All three feed the same slot (`ImportBundle.metadata`), which rides `POST /import-file` and is written to `library` authoritatively; the post-conversion extractor only ever fills blanks.

- **Front matter** is read by `parseFrontMatter` (`resources/js/components/importQueue/vaultMetadata.ts`) on the client and `App\Services\DocumentImport\FrontMatter` on the server. Both are the same deliberate YAML SUBSET — `key: value` scalars, `key:` + `- item` lists, inline `[a, b]` — which covers Hyperlit's exporter, Obsidian's property editor and Zotero-style templates. Keys read: `title`, `authors` / `author` (a list joins with `; `), `year` / `date`, `journal`, `volume`, `issue`, `pages`, `publisher`, `doi`, `source` / `url`, `language`, `license`, `license_url`.
- **`.bib` files** at any depth are parsed by `parseBibFile` (brace-matched, multi-entry — the only such parser in the codebase) and paired to a file by the entry's `file` field, then the note's `citekey`, then a `@citekey.md` filename. The `file` field pairing also matches Zotero's `Title:path:mime` form, so a folder of PDFs plus a Zotero export gets metadata too. A `.bib` is metadata, never an upload: it is not in `isAcceptableImportExt`.
- **The stored `bibtex`** is the paired entry with the vault-only `file` field removed. For a Hyperlit export the entry's `url` names the ORIGINAL Hyperlit book, not the work's source, so it is replaced by the front matter's `source`. With no `.bib` entry the uploader generates one from the fields, because library cards render `bibtex` in preference to the columns.
- **`doi` and `license` are new on `POST /import-file`.** The DOI is stored bare in `library.doi`. A licence must name a code in `App\Support\Licenses` or the row stays `Unknown`; an import never stamps `license_source = 'user'`.

**The block is stripped before conversion, and the rule for "is this front matter" is strict.** It must open on the first line with `---`, close with `---` or `...`, hold at least one `key:` line, and contain nothing else but list items, indented continuations, comments and blanks. A document that merely OPENS with a horizontal rule fails that and loses nothing. `MarkdownProcessor` writes the body to a temporary `conversion_input.md` and leaves `original.md` untouched, because `MetadataExtractor` reads the block from it afterwards and a reconvert re-reads it.

**Skipped, and said so.** A Hyperlit export's generated README (its `hyperlit:` URL names `/a/…` or `/u/…/shelf/…`, a page not a book) and notes with no body are left out of the plan and listed in `plan.skipped`. A pinned overview book used as the hub keeps a single-segment book URL and is treated like any other note.

## Part 2 — notes that are already books

Each exported note names its original: `book:` (the id — written since export schema 7, and immune to a slug rename) and `hyperlit:` (the canonical URL, whose last path segment is the slug or the id). Before anything uploads, the client sends those hints plus any DOI to `POST /api/import-batches/resolve` (`VaultBookResolver`).

**Match order:** the `book` id; then the single path segment of a `hyperlit` URL on an accepted host; then the DOI, via `CanonicalRegistry` and `BestVersionService::bestVisibleVersion`. Accepted hosts are the app's own plus `config('import.vault_hosts')` (default `hyperlit.io`), so a vault downloaded from prod resolves on a dev copy of the library. A SLUG match must also loosely agree on the title — a slug is a name someone can change and someone else can take. An id match is exact.

**Readability is the whole security model.** Every lookup that yields an answer runs on the default connection, so RLS decides: a book the caller cannot read — a stranger's private upload, a deleted book — comes back `new`, exactly like an id that never existed. A crafted vault cannot be used to probe which ids, slugs or DOIs exist. Deleted, content-less, `web_source` and encrypted rows never match.

**One question per drop.** If anything matched, `decideVaultDrop` (`vaultResolve.ts`) asks once:

- **Add the existing books to the shelf** (default) — nothing is imported. The ids go to `POST /api/import-batches` as `existing_books`; the server re-checks that the caller can read each one and puts them on the shelf. With nothing left to upload no batch is registered at all, and the client goes to the shelf.
- **Import my own versions** — each matched note uploads with `version_of: {book id}`. `ImportController` copies the original's citation columns wherever the upload supplied none, takes its licence, and links the new private book to the same `canonical_source` with `canonical_match_method = 'vault_reimport'` (`CanonicalSourceMatcher::linkToExistingCanonical` — link only, no metadata rewrite). An original with no canonical record just gets the metadata.

Unmatched notes are imported as new books either way.

**Hypercite-involved books always use the existing version.** A note that contains a `…#hypercite_…` link, or that another note in the drop links a hypercite INTO, is shelved as the original even when the user chose "my own versions" — the dialog says how many. A hypercite is a link between two specific books; a re-imported copy has only the exported footnote text, with no arrow, no `citedIN` entry and no connection edge. Nothing on the import path rewires hypercites, and this rule is why it does not need to.

**Two vaults in one folder make one shelf; two DROPS make two.** One drop is one `POST /api/import-batches`, so everything in it lands on one shelf, and `shelf_items` is keyed `(shelf_id, book)` so each original book is on it once. A later drop never reuses a same-named shelf — it gets its own, named `Folder (2)`, `Folder (3)`, … (`ImportBatches::ensureShelf`). Reusing by name piled three drops of one folder onto a single shelf, each work two or three times over. To ADD to an existing shelf the user drops onto it while it is open, which arrives as `shelf_id`.

## A single upload

One markdown note dropped or picked on its own used to skip all of this: the one-book shortcut hands the import form the files and nothing else. Now, when the note carries an identity hint, both entry points — the page drop (`fileDropTarget.ts` `routeDrop`) and the form's submit (`citeForm/submission.ts`) — re-plan it with `buildIngestPlan(…, { forceBatch: true })` so it becomes one bundle with its metadata and identity intact, and ask `decideSingleNote` (`vaultResolve.ts`).

- **Open the existing book** — the book is filed on a shelf FIRST and then opened, so it can always be found again. The shelf is the user's own open shelf when they dropped the file onto one, otherwise their private "Imported works" shelf (`imports_shelf: true` on `POST /api/import-batches`, resolved by `HarvestShelf::ensureImportShelfFor`) — the same place a DOI import of a work we already hold lands. It is NOT cloned: it is the original, which is why it is not the user's to edit.
- **Import my own version** — the one bundle uploads through the batch lane with `version_of`, giving a private, editable book in the user's own library. Not offered when the note contains hypercite links; the dialog says why.
- **Not a book we hold, or no hint** — nothing is asked and the import proceeds exactly as before.

Only markdown carries these hints. A PDF or EPUB of a work already in Hyperlit is not recognised before upload.

## A shelved book is findable from the user page

"In your library" (books you own — the feed, the export) and "on one of your shelves" are different things, and a book someone else owns can only reach your page through a shelf. The un-narrowed `/u/{username}` search used to cover owned books alone, so an existing book filed on "Imported works" could only be found by opening that shelf's tab first. `ShelfController::userPageSearchBooks` now makes the default corpus the user's own books PLUS the members of their shelves, under the same visibility rule a single shelf uses: a visitor reaches public members of public shelves; the owner reaches all their shelves and their own private members; nobody reaches another user's private book. This is SEARCH ONLY — `ArchiveCorpusResolver::userLibraryQuery` (export, and "a user's books" generally) is unchanged, so downloading your library never hands you other people's books. The AI Archivist's username scope is a separate corpus and is also unchanged.

## Round-trip fidelity: a vault comes back as the same books

Export then re-import is meant to be a fixed point: the first re-import gives back the book, and every later cycle gives back exactly the same thing. Before `tests/Feature/ArchiveExport/VaultRoundTripTest.php` nothing checked that, and each cycle degraded the book — a `re-import-test` shelf showed every note with its footnotes twice, a quotation repeated inside a footnote, and every reference unmatched.

**An authored Markdown file is not a printed page.** The OCR lane and a user's `.md` upload run the same two scripts (`simple_md_to_html.py` → `process_document.py`), but they mean different things by `[^1]: note`. In OCR output it is a notes block printed on the page, and it stays in the body. In a file someone wrote it is markup. `MarkdownProcessor::process(..., authoredMarkdown: true)` (the default; `PdfProcessor` and the review-report importer pass `false`, and the import job passes `false` for a reconvert whose only source is OCR's `main-text.md`) adds `--markdown-source`, which switches on the passes in `app/Python/digestion/markdownSource/`:

- **Definitions leave the body.** Once a `[^n]:` definition is a footnote AND a marker links to it, its paragraph and the continuation blocks folded into it are removed, with the rule that separated them from the text. A definition no marker links to stays, because removing it would make its text unreachable.
- **Obsidian block ids are not printed.** A trailing ` ^harvey2020` is taken off before the bibliography extractor reads the paragraph (it was being stored as part of the reference), and `[2020](#^harvey2020)` is re-aimed at the entry it named.
- **A citation link says which reference it stood for.** The vault points a citation at the cited work's own note, or its DOI, when it can — and then the href no longer names the reference. So the export writes the reference's text as the link's TITLE (`[2020](Note.md "Harvey, David. 2020. …")`): the hover in any editor, and what `ResolveVaultCitationLinks` matches on (letters and digits only, the title a prefix of exactly ONE entry — a title that fits two claims neither).

Two fixes apply to every lane: a `<blockquote>` (or list, or table) inside a footnote was stored twice, because `find_all` returns the container and its inner paragraph separately; and `[text](url "title")` used to put the title inside the href.

**An imported footnote keeps its blocks.** Every import path used to push a footnote's content through `strip_tags` into a single `<p>`, so a footnote of three paragraphs and a quotation was stored as one run of text (and its words were welded together at the joins). `App\Services\DocumentImport\FootnoteBlocks` now turns it into one sub-book node per block — paragraph, `<blockquote>`, list — the shape a footnote written in the editor has always had. Used by all three writers (`ProcessDocumentImportJob`, `ConversionArtifactSaver`, `ImportController`); it applies to PDF, EPUB and Word imports too, not just Markdown.

**Matches and verifications are inherited.** A fresh import writes only `referenceId` and `content`, so a re-imported copy came back with nothing matched. When the upload is a version of a book the uploader can read, `ImportController` passes that book to the job as `inherit_citations_from` (the resolved original, never the raw `version_of` input) and `ResolutionSnapshotService::inheritFrom` carries its bibliography and footnote resolution across — key first, then reference text, never over a value the new row already holds. It only works where the original still exists on this instance; nothing is carried inside the vault file.

**What still differs, on purpose** (asserted exactly in the test, so it can only change deliberately):

- A hypercite arrow comes back as an ordinary footnote holding the citation. Nothing on the import path rewires hypercites, which is why hypercite-involved notes are forced to the existing book above.
- A citation made with the editor's citation inserter (`a.citation-ref`) comes back as a "References" section in the body, linked by the importer under a new author-year id.
- In the Zettlr vault a citation with nowhere to point (no note, DOI or URL) is plain text, and one that shares a parenthetical with a linked citation is not re-linked on the first re-import.

## When touching this, check

- A new front-matter key is added to BOTH readers (`vaultMetadata.ts` and `FrontMatter.php` consumers) and to `METADATA_KEYS` in `batchUploader.ts`, and `ImportController::store` validates it.
- The front-matter test stays strict. Loosening it to "anything between two rules" deletes the first section of every document that opens with `---`.
- `existing_books` are re-verified server-side with `VaultBookResolver::readableBook`. The shelf append can run on `pgsql_admin`, so that check is the only thing stopping a forged id from shelving a book the caller cannot read.
- A new export field that identifies a book bumps `ArchiveExportStore::SCHEMA_VERSION`.
- The resolve route keeps its named limiter (`import-resolve`).

## Not built

- Hypercite links inside a NEW note (one the user wrote in the vault) stay plain links. Turning them into real two-way hypercites needs a `citedIN` write the hypercite's creator alone may make.
- Non-owned books do not appear in the user page's all-books FEED, only in its search and on their shelf.
- Edits made to an exported note are not detected. Choosing "existing" discards them; "my own versions" is the path that keeps them.
- The maintainer shelf-import drop (`workbenches/journalImport/shelfDrop.ts`) does not run the resolve step.

## Tests

- `tests/javascript/components/vaultMetadata.test.js` — both parsers on real export excerpts, field precedence, identity hints, the plan wiring (`.bib` as metadata, hub and empty notes skipped, manifest still wins), the forced-existing rule, the existing/own split, and the uploader's wire format including the zero-upload drop.
- `tests/Feature/Api/VaultReimportTest.php` (PHP suite) — `FrontMatter` and its negative, resolve by id / slug / DOI and every "comes back new" case, `existing_books` shelving with forged ids, `doi` / `license` storage, `version_of` inheritance and its refusal, the worker-context metadata fill, and a real conversion proving the block never reaches the body.
- `tests/Feature/ArchiveExport/ArchiveExportTest.php` — the exported `book:` key.
- `tests/Feature/ArchiveExport/VaultRoundTripTest.php` (PHP suite) — the round trip itself, both vault flavours, through the real export and the real Markdown import: generation 1 against the original, generation 2 against generation 1.
- `tests/conversion/unit/test_markdown_source_passes.py` + `tests/conversion/fixtures/md/vault_export/` (pytest / `run_regression.py`) — the authored-Markdown passes, the flag being OFF for OCR, the once-only quotation and the titled link.
- `tests/Feature/UserLibrarySearchModesTest.php` — the un-narrowed search reaching shelved books, for a visitor and for the owner, and never another user's private book.
