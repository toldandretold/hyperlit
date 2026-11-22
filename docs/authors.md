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

`php artisan authors:suggest` proposes links for unlinked books by splitting `library.author` with the author-list vocabulary and matching each name against aliases (then, for unknown names, Wikidata search restricted to humans, with dates where the book has a year). Suggestions land in a review queue (a workbench lane under `/maintainer/…`, admin-gated by the route table); confirming writes `book_authors` with `source = review`. Nothing auto-merges: "Marx, Karl" is safe, "Smith, J." is not, and a wrong merge silently puts one person's books on another's page. Role detection from the string is suggestion-only too ("Fowkes, Ben" as translator needs a human or the work's metadata). The classics — the people whose pages matter first — are few enough to confirm by hand.

## The marxists.org import, revised

MIA is organised author-first (`/archive/lenin/`, each author with a works index), which is exactly this model. With authors in place:

- The scrape starts from an author's works index (the enumerator `ignore/marxists-recon/FINDINGS.md` says Collected Works volumes need anyway) and every work it emits belongs to that author by construction.
- `manifest.json` gains an `authors` field — a list of `{name, role, wikidata?, slug?}` — so books are linked at birth with `source = manifest`, never string-matched later. A small hand-kept map from MIA archive folders to Wikidata QIDs (`lenin` → Q1394, `marx` → Q9061, …) resolves the scraped author; an unmapped folder imports with the name only and lands in the suggestion queue.
- The index page's info block already names the translator ("Translated:" / "Source: … translated by …"), which the recon collects into provenance — it becomes a `translator` link instead of being lost or mistaken for an author.

## Build order

1. `authors` + `book_authors` + the vocabulary of roles, with RLS (public read for public books' links, writes admin / book owner) and a seed of the handful of classics by hand.
2. `authors:suggest` + the review lane; seed links from `canonical_source.authorships`.
3. `archive_sources.kind = author`, `AuthorShelfSync`, and `/a/{slug}` rendering an author archive (about copy can start from the Wikidata description, edited by hand).
4. `author:` in search.
5. The marxists.org scraper as an artisan command, author-first, emitting the drop folder with `authors` in the manifest.

## Gates to add when building

Following the CLAUDE.md pattern (a rule + a test that fails): the derived author shelf has ONE writer (a test that fails on any other code writing `shelf_items` for an author shelf); `library.author` is never rewritten from `book_authors`; an author slug and an archive slug can never collide (it is one unique column); and `author:` results still pass through `diversifyByBook`.
