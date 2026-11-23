# Authors as identities (design — not yet built)

Status: proposed 2026-11-22. Decisions taken by the user: author pages live under `/a/` beside archives, and a translation counts as its author's work (Lenin's page shows his works in every language).

## The problem

Hyperlit has no author identities. An author is the free-text `library.author` string, written in whatever form the source gave it, so the same person splits and different roles merge. Measured on prod 2026-11-22: Lenin is "V. I. Lenin" on one book and "Lenin, V. I." on another (locally also "Lenin, Vladimir Ilyich"); the Penguin Capital is credited to "Marx, Karl and Fowkes, Ben and Mandel, Ernest" — a translator and an introduction-writer flattened into co-authors; and a metadata search for "Lenin" returns Raju J. Das's *Lenin's Marxism*, a book ABOUT him. `canonical_source.authorships` (OpenAlex author ids + ORCID, `WorkNormaliser`) is the only structured author data, it exists only for works OpenAlex matched (767 of 2,701 canonicals locally), and it is useless for historical authors: the dead have no ORCID, and OpenAlex scatters a classic author across many author records.

So none of these can be built honestly today: an author page (`/a/lenin` with search over only Lenin's works), an `author:lenin` search operator, "more by this author" on a book, or a scraper that files a book under its author at birth.

## The model

**`authors`** — one row per PERSON (or corporate author): `id` (uuid), `slug` (the URL key, globally unique against archive slugs too — see below), `display_name` ("V. I. Lenin"), `sort_name` ("Lenin, V. I."), `aliases` (jsonb list of every spelling seen or known, including other scripts — "Ленин", "Lenin, Vladimir Ilyich"), `wikidata_qid`, `openalex_ids` (jsonb list — OpenAlex splits people, so it is many), `orcid`, `viaf`, `born` / `died` (years, for disambiguation), `created_by` / timestamps. Wikidata is the primary external key because it covers the dead, is CC0, and links onward to VIAF, LoC, OpenAlex and every Wikipedia; ORCID and OpenAlex are secondary keys for modern scholars.

**`book_authors`** — the link, at the `library` row (the version), not `canonical_source`: `book`, `author_id`, `role` (`author` / `translator` / `editor` / `introduction` / `compiler`), `position` (order within the role), `source` (`manifest` / `openalex` / `user` / `review` — who asserted it), `confirmed_at`. Library rows, not canonicals, because everything that would consume this — search, shelves, feeds, RLS, the archive page — works on library rows, and marxists.org imports arrive canonical-less. Where a canonical's `authorships` exist they SEED the links of its versions (`source = openalex`).

**`library.author` stays.** It is the credit as printed and the citation string, governed by the author-list vocabulary (`AuthorList.php` / `authorList.ts`, `"; "`-joined, full list). Identity is a separate layer beside it; nothing rewrites the string from the links, and a book with no links is still a perfectly good book.

**A translation is the author's work.** Lenin's page lists every book where Lenin holds role `author`, whatever its language; the translator holds role `translator` on the same book and is credited, not listed as an author. A person who is both (Engels wrote and translated) gets each role on the right books, and their page can show "Translations by" as its own section later.

## Author pages: an archive whose shelf is derived

An archive today is a public shelf plus an `archive_sources` row (slug, display name, about copy, certified flag), and every feature of `/a/{slug}` — the hero, Most Recent / Connected / Lit, full-text + semantic search (`ShelfController::publicSearchCorpus`, diversified by `SearchService::diversifyByBook`), the cited-texts reach, the vault export, the shelf-owner hypercite workbench — reads the shelf's members. So an author page is an archive whose shelf is MAINTAINED, not curated: `archive_sources` gains `kind` (`collection` default / `author`) and `author_id`, and a system-owned public shelf holds exactly the public books where that author has role `author`. Every existing archive feature then works on day one, and `archive_sources.slug` being unique already makes author slugs and archive slugs one namespace, so `/a/lenin` can never mean two things.

**One writer.** The derived shelf is written ONLY by an `AuthorShelfSync` service, called whenever a `book_authors` link or a book's visibility changes (and by a nightly reconcile as the backstop) — the same single-writer discipline as the likes shelf. Curating an author shelf by hand is refused (the next sync would undo it silently). The shelf's render cache (`shelf_{id}_{sort}`) is dropped through the existing `ConnectionRefresher`-style flush.

## `author:` in search

The homepage search (and any shelf search) parses `author:lenin` / `author:"rosa luxemburg"` out of the query, resolves it against `authors.slug` + `aliases` (exact, case- and diacritic-insensitive), and filters the candidate books by `book_authors` (role `author`) before ranking. An unresolved name falls back to the old string match on `library.author` and says so in the response, rather than silently returning nothing. Diversification still runs through `diversifyByBook` — an author filter does not exempt a query from the one-book-takes-every-slot rule.

## Linking existing books: suggestions, never silent merges

One suggester, two places to confirm. The suggester splits `library.author` with the author-list vocabulary and matches each name against aliases (then, for unknown names, Wikidata search restricted to humans, with dates where the book has a year). Nothing auto-merges: "Marx, Karl" is safe, "Smith, J." is not, and a wrong merge silently puts one person's books on another's page. Role detection from the string is suggestion-only too ("Fowkes, Ben" as translator needs a human or the work's metadata).

**Who confirms is whoever owns the library row** — the same rule RLS already applies to every other edit of a book's metadata:

- **A user's own book** (an upload, a paste, a URL import they made): the suggestion appears in the source container beside the author credit — "Is this V. I. Lenin (1870–1924, Russian revolutionary)? Yes / No / Someone else" — and confirming writes `book_authors` with `source = user`. The owner knows what they uploaded better than any maintainer does, and asking them costs nothing. The same choice is offered at import time when the suggester is confident, and MCP `set_book_metadata` can carry it.
- **A system-minted book** (OpenAlex harvest, ar5iv, journal lanes, marxists.org — `creator` is the system): links arrive with the book (`source = openalex` / `manifest`), and whatever is left unresolved goes to the maintainer review lane (`/maintainer/…`, admin-gated by the route table), confirmed with `source = review`.

**What an owner may NOT do is change the identity itself.** The `authors` table is shared: creating a new person, editing aliases, merging two rows or splitting one changes every book and page that points at it, so those are maintainer actions. An owner choosing "Someone else" with no match files a proposal for a new author into the maintainer lane, and their book stays unlinked (still a perfectly good book) until it is decided.

**Abuse.** An owner-confirmed link puts a public book on that author's `/a/` page and in `author:` results — exactly as anyone can already publish a book whose author string says "Lenin". So `source = user` links are kept distinguishable: a maintainer can detach one (recorded, so the suggester does not re-propose it), and the author page can later choose to show owner-linked books in their own section if spam ever appears. Not built until it is needed.

`php artisan authors:suggest` runs the suggester in bulk (for the backlog: in practice almost every book on the site today was imported by the site's maintainer, so the first pass is the maintainer's lane either way). The classics — the people whose pages matter first — are few enough to confirm by hand.

## The marxists.org import, revised

MIA is organised author-first (`/archive/lenin/`, each author with a works index), which is exactly this model. With authors in place:

- The scrape starts from an author's works index (the enumerator `ignore/marxists-recon/FINDINGS.md` says Collected Works volumes need anyway) and every work it emits belongs to that author by construction.
- `manifest.json` gains an `authors` field — a list of `{name, role, wikidata?, slug?}` — so books are linked at birth with `source = manifest`, never string-matched later. A small hand-kept map from MIA archive folders to Wikidata QIDs (`lenin` → Q1394, `marx` → Q9061, …) resolves the scraped author; an unmapped folder imports with the name only and lands in the suggestion queue.
- The index page's info block already names the translator ("Translated:" / "Source: … translated by …"), which the recon collects into provenance — it becomes a `translator` link instead of being lost or mistaken for an author.

## Build order

1. `authors` + `book_authors` + the vocabulary of roles, with RLS (public read for public books' links, writes admin / book owner) and a seed of the handful of classics by hand.
2. The suggester + `authors:suggest` + the maintainer review lane; seed links from `canonical_source.authorships`. Then the owner-facing prompt in the source container (and at import), with `source = user`.
3. `archive_sources.kind = author`, `AuthorShelfSync`, and `/a/{slug}` rendering an author archive (about copy can start from the Wikidata description, edited by hand).
4. `author:` in search.
5. The marxists.org scraper as an artisan command, author-first, emitting the drop folder with `authors` in the manifest.

## Gates to add when building

Following the CLAUDE.md pattern (a rule + a test that fails): the derived author shelf has ONE writer (a test that fails on any other code writing `shelf_items` for an author shelf); `library.author` is never rewritten from `book_authors`; an author slug and an archive slug can never collide (it is one unique column); and `author:` results still pass through `diversifyByBook`.
