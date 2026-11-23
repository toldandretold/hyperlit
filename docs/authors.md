# Authors as identities

Status: the first slice was built 2026-11-23 (tables, Wikidata-backed author records, author pages under `/a/`, linking from verified canonicals, the admin import manifest, the maintainer commands). Still design only: user-submitted links, the review lane, and `author:` in search — see §"Not built yet". Decisions taken by the user: author pages live under `/a/` beside archives; a translation counts as its author's work (Lenin's page shows his works in every language); and an author a verified work names by id, whom we do not hold yet, is created automatically from Wikidata.

## The problem

An author used to be only the free-text `library.author` string, written in whatever form the source gave it, so the same person split and different roles merged. Measured on prod 2026-11-22: Lenin is "V. I. Lenin" on one book and "Lenin, V. I." on another; the Penguin Capital is credited to "Marx, Karl and Fowkes, Ben and Mandel, Ernest" — a translator and an introduction-writer flattened into co-authors; and a metadata search for "Lenin" returns Raju J. Das's *Lenin's Marxism*, a book ABOUT him.

**Citation verification does not, by itself, say who a person is.** Only OpenAlex-built canonicals carried author ids (767 of 2,701 locally). Open Library and Semantic Scholar canonicals kept a name string — the Open Library search never asked for `author_key` — and the classics are the worst case ("The Poverty of Philosophy": `author: "Karl Marx"`, no ids). OpenAlex scatters one classic author across several author ids. And the "Citation Verified" pill shows for ANY canonical link, including automated title matches, so it is weaker than it reads. The services also do not agree with each other on who anyone is.

## Wikidata is the bridge

One Wikidata entity per person gives the name, every spelling in every script, birth and death years, and that person's id on each service verification uses: Open Library author key (P648), OpenAlex author id (P10283), ORCID (P496), VIAF (P214). So "is this the right WORK" stays the job of citation verification, and "which PERSON wrote it" is answered by joining the work's author id to the Wikidata entity that lists the same id. `App\Services\Authors\WikidataAuthorSource` is the reader (plain `wbgetentities`; `parse()` is pure and unit-tested).

Weak spots, known: OpenAlex splits people, so an OpenAlex-verified classic often falls back to the spelling match; modern scholars often have no Wikidata entry (the ORCID on the work would have to be the identity itself — not built); and Wikidata is community-edited, which is why creation requires both sides to agree (below).

## The model

**`authors`** — one row per person: `slug` (the URL key), `display_name`, `sort_name`, `description`, `aliases` (jsonb, every spelling) with `alias_keys` (text[], GIN — the normalised keys lookups use), `wikidata_qid` (unique; the identity), `open_library_ids` / `openalex_ids` (jsonb lists — services split people, so each is many), `orcid`, `viaf`, `born` / `died`. ONE writer: `App\Services\Authors\AuthorRegistry`.

**`book_authors`** — the link, at the `library` row (the version), not `canonical_source`: `book`, `author_id`, `role` (`author` / `translator` / `editor` / `introduction` / `compiler`), `position`, `source` (`manifest` / `canonical` / `maintainer` / `import` — who asserted it). Library rows because everything that consumes this (shelves, search, feeds, the archive page) works on library rows and marxists.org imports arrive canonical-less. ONE writer: `App\Services\Authors\AuthorLinker`, and every write re-syncs the author's shelf.

Both tables have no RLS and the app database role holds **SELECT only** (the migration REVOKEs first — this database's default privileges grant full DML on new tables); the two services write on `pgsql_admin`.

**`library.author` stays.** It is the credit as printed and the citation string, governed by the author-list vocabulary (`AuthorList.php` / `authorList.ts`). Identity is a separate layer beside it; nothing rewrites the string from the links, and a book with no links is still a perfectly good book.

**A translation is the author's work.** Lenin's page lists every book where Lenin holds role `author`, whatever its language; the translator holds role `translator` on the same book and is credited, not listed.

**Names are compared through ONE normaliser**, `AuthorKey::for`: case, diacritics, punctuation, spacing and surname-first order are ignored ("Marx, Karl" = "Karl Marx", "V.I. Lenin" = "V. I. Lenin"); other scripts are kept, not transliterated. It is exact after that — no initials-vs-full-name guessing. Two further guards: a single-token key ("Marx") is never matchable (Wikidata lists bare surnames as aliases), and a spelling recorded by two authors identifies neither.

## Author pages: an archive whose shelf is derived

An archive is a public shelf plus an `archive_sources` row, and every feature of `/a/{slug}` reads the shelf's members. So an author page is an archive whose shelf is MAINTAINED, not curated: `archive_sources.kind = 'author'` + `author_id`, and a public shelf (`shelves.kind = 'author'`, owned by `AutoVersionResolver::CREATOR`) holding exactly the **public, content-bearing** books where that author holds role `author`. The page renders through the existing maintainer-archive branch of `ArchivePageController`. Its hero line is the author's name and dates ("Karl Marx (1818–1883)") — deliberately NOT Wikidata's one-line description, which is somebody's contestable summary ("German-born philosopher"); the page carries no biography and no link to one. Under it, `App\Services\Authors\AuthorPageSources` credits where the page's public texts came from ("Texts from marxists.org (5)" — the scrape site or the source URL's host) and, a step smaller, the Hyperlit users who imported them, linked to `/u/`. Both are derived on each render, never stored. The collection is cited to "Hyperlit" (`ArchiveCorpusResolver`), not to "{name} maintainers". Feeds, full-text and semantic search, cited texts and the vault export all work because they read shelf members.

**One writer: `App\Services\Shelves\AuthorShelf`.** `sync(authorId)` is set-based; it is called by `AuthorLinker` on every link change, by `DbLibraryController` when an owner changes visibility, and by `ProcessDocumentImportJob` when a book gains content. `authors:reconcile` (daily, 05:50) is the backstop for the visibility writers that do not call it (MCP, hosting policy, deletes). The kind is in `ShelfKinds::SYSTEM`, which is what refuses hand add / import-onto / archive-minting.

**The page is minted lazily**, on the author's first public book (or by `authors:add`) — an author known only from someone's private upload gets no empty public page. Because of that, "is this `/a/` slug free" checks `authors.slug` as well as `archive_sources.slug` (`ShelfArchiveMinter::isAvailable`, the maintainer console), and `AuthorRegistry` refuses a slug a collection archive already has. One namespace: `/a/lenin` can never mean two things.

## How a book gets linked

**From an admin's import manifest** (`source = manifest`) — see §"The marxists.org import". Linked at birth.

**From a marxists.org link import** (`source = import`) — `App\Services\Authors\MarxistsAuthors` reads the page's own author credit through a fixed, checked name → (slug, QID) map; it links for any importer because the map is ours, not the caller's. See `docs/marxists-import.md`.

**From a verified canonical** (`source = canonical`) — `AuthorLinker::linkFromCanonical`, called by `CanonicalSourceMatcher::verifyAndLink` and `SystemVersionMinter::mintSystemRow`, and in bulk by `authors:link-verified`. Only for a canonical link made by a method in `AuthorLinker::TRUSTED_METHODS` (`user_verified`, `auto_version_creation`, `single_work_import`, `openalex_doi`, `existing_doi`, `existing_openalex_id`) — an automated title match must not carry an identity (a user's essay called "Capital" matched to Marx's). Each person the canonical names is placed by id first (Open Library author key, ORCID, OpenAlex author id against the author's stored ids), else by an exact recorded spelling. This step makes no network call. A caller mid-request passes the canonical it just linked: the row may sit in a default-connection transaction the `pgsql_admin` read cannot see yet.

**An id we hold no author for is looked up, and the author created** — `ResolveBookAuthorsJob` (queued, never inside the verify request) → `AuthorResolver`. An Open Library key resolves through Open Library's own author record (`remote_ids.wikidata`), an ORCID or OpenAlex id through Wikidata search (`haswbstatement`). The author is created only when **both sides agree**: the id leads to exactly one entity, the entity is a human, and the entity itself lists that same id. A name with no id never creates anyone. The work's own spelling is deliberately NOT recorded as an alias (names and ids are paired by list position upstream; a mispairing would teach one person another's name). Every outcome is logged with the book and id; `authors:remove {slug}` takes down a wrongly created author with its links and page.

**By hand** (`source = maintainer`) — `authors:link {book} {slug} --role=`. For a book nothing else names an author for (`capital` is user-verified but has no canonical).

To give Open Library canonicals ids at all, `OpenLibraryService` now requests `author_key` and returns `authorships` of `{name, open_library_author_key}`; `backfillOaFields` fills a name-only canonical's empty `authorships` when the same work is looked up again.

## Reviewing what we already hold

Two commands, both dry runs by default, both paging by key and stopping (exit 2) after 5 consecutive failures of a source rather than marching on:

- `authors:backfill-canonical-ids` — Open Library canonicals stored with a name only (260 locally) are asked for their author names and keys (one paired answer per work) and gain `authorships`. `canonical_source.author` and every library row are untouched. OpenAlex canonicals without author ids are only counted; `--openalex` delegates to `library:backfill-authors --refetch`, which also repairs truncated author strings — a wider change, so it is opt-in.
- `authors:link-verified` — runs `linkFromCanonical` over every book with a trusted canonical link and reports: books that link (and by what), author ids we hold nobody for, and names left unlinked. A dry run makes no network call unless `--lookup` asks Wikidata which unknown ids WOULD become authors; `--apply` writes links and queues the lookups.

## The marxists.org import

MIA is organised author-first, which is this model. `manifest.json` entries carry `authors`: a list of `{name, role, slug?, wikidata?}`. `folderIngest.ts` keeps well-formed entries (an entry with neither a slug nor a QID identifies nobody and is dropped), `batchUploader.ts` sends the list as one JSON string field `authors_json`, and `ImportController` hands it to `App\Services\Authors\ManifestAuthors` **for admin imports only** — an entry can create an author and puts a book on a public page, so anyone else's is ignored (it stays in `raw_json`). Books are born private and join the page when published.

`ignore/marxists-recon/make_drop.py` emits the field. The identity comes from the page's own author credit through a small name → (slug, QID) map, NOT from the archive folder: the Marx/Engels archive files Engels' works under `/archive/marx/`. A credit naming anyone outside the map gets no `authors` and is reported, never guessed. Translators are not emitted: the info block names them in free text with no id.

## Commands

- `authors:add {slug} --wikidata=Q…` (`--name=`, `--sort=`, `--alias=*` override, or serve an author with no Wikidata entry); mints the page at once.
- `authors:refresh {slug?}` — re-pull from Wikidata; spellings and ids only grow.
- `authors:link {book} {slug} --role= [--unlink]`.
- `authors:remove {slug}` — the author, its links, shelf and page; books untouched.
- `authors:backfill-canonical-ids`, `authors:link-verified`, `authors:reconcile` — above.

## Not built yet

- **Owner-submitted links.** The owner of a user-uploaded book confirming "is this V. I. Lenin?" in the source container, with `source = user`. Planned to lean on the commoner score: an approved contribution raises it, and a trusted commoner's links are eventually accepted without review. Until then a non-admin's manifest `authors` is ignored and unverified uploads stay unlinked.
- **The suggest-and-review lane** for books no id and no exact spelling can place (names like "Smith, J."), and for role fixes (the Penguin Capital's translator).
- **`author:` in search** — parse `author:lenin` out of the homepage / shelf query, resolve it against `slug` + `alias_keys`, filter candidate books by `book_authors` before ranking, and still diversify through `SearchService::diversifyByBook`. Search WITHIN one author already works: it is the `/a/{slug}` page's search box.
- **A works-list enumerator** for marxists.org Collected Works volumes and author indexes. Importing ONE work by pasting its link is built (`docs/marxists-import.md`); importing a whole author is not.
- **Org / corporate authors from Wikidata**, "Translations by" sections, "more by this author" on a book.

## Tests

`tests/Feature/Api/AuthorIdentitiesTest.php` (name matching, trusted-method linking, id-beats-name, the shelf's membership rule, the `/a/` page and its search, refusal of hand curation, the shared namespace, Wikidata creation and each refusal, the admin-only manifest, both review commands, the verify hook) + `tests/Feature/Architecture/AuthorSingleWriterTest.php` (one writer per table, SELECT-only grants, nothing writes `library.author` from an author record) + `tests/Unit/Authors/AuthorKeyAndWikidataTest.php`; JS: the `authors` cases in `tests/javascript/components/folderIngest.test.js` and `batchUploader.test.js`. No test touches the network.
