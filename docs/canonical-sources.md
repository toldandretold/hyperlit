# Canonical Sources & Versions

How Hyperlit distinguishes "the work being cited" from "the particular uploaded version of it," and how the system reasons about how legitimate each piece is.

## The problem

A single work (say, Marx's *Capital Vol 1*, Penguin/Fowkes 1976) can end up in the database multiple times: one user uploads a scanned PDF, another paste-imports the EPUB, a third lets the auto-pipeline ingest an OpenAlex stub. Pre-canonical-source, those were three unrelated rows in `library`; there was no notion that they referred to the same work, no way to compare a citation against the *most trustworthy* version, no way to express "this PDF was put here by the publisher" vs. "this is some user's sloppy retype."

## The model

```
        ┌────────────────────────────────────┐
        │         canonical_source           │   ← "what the work is" (citation identity)
        │  doi, openalex_id, canonical title │      Established via OpenAlex / Open Library /
        │  abstract, work_license, pdf_url   │      Semantic Scholar / user assertion / admin.
        │                                    │
        │  author_version_book   ──┐         │
        │  publisher_version_book ─┤         │
        │  commons_version_book  ──┤   ← quick-draw pointers to privileged versions
        │  auto_version_book     ──┤         │
        └────────────────────────────────────┘
                                  │
                                  ▼   (canonical_source_id FK)
        ┌────────────────────────────────────┐
        │             library                │   ← "this particular upload/render" (version)
        │  book PK, creator, creator_token   │      Owns content (nodes, hyperlights), conversion
        │  conversion_method, license, ...   │      provenance, engagement metrics, credibility.
        │  canonical_source_id (nullable)    │
        │  canonical_match_score             │   ← identity confidence (did we get the right work?)
        │  canonical_metadata_score          │   ← metadata quality (is this library row sloppy?)
        └────────────────────────────────────┘
```

**One canonical, many versions.** A canonical row is optional — many `library` rows have `canonical_source_id = NULL` because no match has been found (or attempted). When it's set, the library row is "recognised as a version of" that canonical. Existing rows are never disturbed; the canonical layer is purely additive.

## Files & schemas

| Concern | Table | Model |
|---|---|---|
| Canonical identity | `canonical_source` | `App\Models\CanonicalSource` |
| Version (uploaded copy) | `library` | `App\Models\PgLibrary` |

Migrations adding the canonical layer:
- `2026_05_16_000001_create_canonical_source_table.php` — the canonical table.
- `2026_05_16_000002_add_canonical_columns_to_library_table.php` — `canonical_source_id`, version-level provenance.
- `2026_05_16_000003_add_oa_columns_to_canonical_source.php` — `pdf_url`, `oa_url`, `work_license`, `semantic_scholar_id`.
- `2026_05_16_000004_add_match_metadata_and_auto_version.php` — link metadata + `auto_version_book`.
- `2026_05_17_000001_add_canonical_metadata_score_to_library.php` — the second score.
- `2026_05_17_000002_add_authorships_to_canonical_source.php` — structured author list incl. ORCID.

## Canonical legitimacy — verification signals stack

A canonical row is not "verified" or "unverified" — it's "verified by what," and signals accumulate. Each canonical can carry any combination of:

| Signal | Meaning | Set by |
|---|---|---|
| `openalex_id` | Recognised by OpenAlex (academic-publishing authority) | matcher / ingest pipeline |
| `open_library_key` | Recognised by Open Library (books authority) | matcher / ingest pipeline |
| `semantic_scholar_id` | Recognised by Semantic Scholar | matcher |
| `doi` | Has a registered DOI | usually inherited from one of the above |
| `verified_by_publisher` (bool) | Rights-holder / publisher has claimed this canonical | admin (future) |
| `commons_endorsements` (int) | Number of users who've endorsed it as legit | commons system (future) |
| `creator` / `creator_token` | User who first asserted this canonical (NULL if auto-ingested) | API-side or user form |
| `foundation_source` | Origin tag: `openalex_ingest` / `open_library_ingest` / `semantic_scholar_ingest` / `user_asserted` / `admin_curated` | matcher / ingest |
| `authorships` (JSONB) | Structured author list: name, OpenAlex author ID, **ORCID**, position (first/middle/last), corresponding-author flag. GIN-indexed. Populated when canonical is created via OpenAlex API (DOI or title search). NULL for canonicals created via "promote" path, Open Library, or Semantic Scholar (those sources don't return ORCID). | matcher (OpenAlex paths) |

A canonical for a niche book starts as `creator=<user>, foundation_source=user_asserted, openalex_id=NULL`. If it later turns up in OpenAlex, we stamp `openalex_id` onto the existing row — no migration, no merge. The "kind" of canonical is **derivable from which signals are populated**, not a single enum.

## Version legitimacy — what we know about a library row

When a library row has `canonical_source_id` set, six columns describe the link:

| Column | What it means |
|---|---|
| `canonical_source_id` | Which canonical this version is a copy of. |
| `canonical_match_score` (0–1) | **Identity confidence.** Are we sure it's the same work? `1.0` for DOI / openalex_id / open_library_key matches; computed metadata score for title-only matches. |
| `canonical_metadata_score` (0–1) | **Metadata quality.** How well the library row's *own* title/author/year/journal aligns with the canonical's. **Low value here, even when match_score is high, means the library row is sloppy.** |
| `canonical_match_method` | How the link was established (see method values below). |
| `canonical_matched_at` | When. |
| `canonical_matched_by` | What set the link (`canonicalizer_v1` for the automated matcher; admin overrides will use different identifiers). |

Plus version-level provenance, independent of any canonical link:

| Column | What it means |
|---|---|
| `conversion_method` | How the content was produced: `pdf_ocr` / `pdf_ocr_auto_raw` / `epub_import` / `docx` / `html` / `markdown` / `manual` / `openalex_stub`. |
| `human_reviewed_at` | NULL = no human ever opened/edited it (raw pipeline output). Set when a logged-in user saves the editor. |
| `is_publisher_uploaded` | Only true when the uploader's verified identity matches the canonical's publisher/author. |
| `credibility_score` | Reserved. Algorithm ships later (will combine uploader trust + engagement signals). |
| `creator` / `foundation_source` | Who/what created the row in the first place. |

## The two scores in plain English

| Scenario | match_score | metadata_score | What it tells you |
|---|---|---|---|
| Clean OpenAlex-DOI'd upload | 1.00 | 0.85–1.00 | Verified work, clean library data. **Trustworthy.** |
| User typed a citation, DOI is right, title is garbage | 1.00 | 0.00–0.30 | Right work, **sloppy/dishonest library row**. Downgrade credibility. |
| Title search, decent match | 0.65 | 0.65 | Same value by construction — the title search *is* the metadata score. Probably the right work, judge by how close to 1.0. |
| `canonical_source_id` IS NULL | NULL | NULL | Unverified. We have no external truth to compare against. |
| Auto-version (system-generated) | 1.00 | 1.00 | The library row was *created from* the canonical, so by construction the metadata matches. Trust depends on `conversion_method` + downstream credibility. |

**Smoke-tested live**: a library row whose openalex_id matched a canonical was given the title "completely wrong title about cats" — the matcher correctly recorded `match_score = 1.0` (identifier still matches) and `metadata_score = 0.0` (title floor in `OpenAlexService::metadataScore` rejected it). That's the divergence signal in action.

## Privileged version pointers on the canonical

The canonical row holds four FK columns pointing at *which version is privileged* in different ways:

| Pointer | Meaning | Set by |
|---|---|---|
| `author_version_book` | The version uploaded by the verified author | manual / admin once identity verification is wired |
| `publisher_version_book` | The version uploaded by the verified publisher | same |
| `commons_version_book` | The version most endorsed by the community | commons system (future) |
| `auto_version_book` | The system-generated version: vacuum + Mistral OCR of the canonical's `pdf_url`. **"Auto-raw" — untampered but possibly badly formatted.** | `library:create-auto-versions` |

Multiple may be set on the same canonical (an author's version AND a commons-endorsed user version can coexist). Each pointer is a quick-draw shortcut for downstream features (e.g. citation-checking should prefer `author_version_book` → `publisher_version_book` → `commons_version_book` → highest-credibility version).

## The matching tool — `library:canonicalize`

`App\Console\Commands\CanonicalizeLibraryCommand` (service: `App\Services\CanonicalSourceMatcher`).

For each library row, attempts these in order; stops at the first hit:

1. **Existing canonical via identifier** — look up `canonical_source` by the library's `openalex_id` / `doi` / `open_library_key`. (No API call.) `match_score = 1.0`.
2. **Promote OpenAlex metadata** — if the library row already has `openalex_id`, create a canonical directly from its own fields. (No API call.) `match_score = 1.0`.
3. **OpenAlex DOI lookup** — `GET /works/doi:<doi>` via `OpenAlexService::fetchByDoi`. `match_score = 1.0`.
4. **OpenAlex title search** — score candidates with `OpenAlexService::metadataScore`, accept if ≥ 0.5.
5. **Open Library title search** — `OpenLibraryService::search`, same threshold.
6. **Semantic Scholar title search** — `SemanticScholarService::search`, same threshold.
7. **Shortened-title retry** — if title contains `:` (subtitle separator), strip after it and retry OpenAlex → Open Library → Semantic Scholar.

After every successful link, the matcher additionally computes `canonical_metadata_score` (library-vs-canonical metadata comparison) — this is what surfaces sloppy library rows even when identifier matching succeeded.

Usage:
```
php artisan library:canonicalize                    # backfill every unmatched library row
php artisan library:canonicalize --missing-only     # only rows without canonical_source_id
php artisan library:canonicalize --book=<id> -v     # one row, verbose
php artisan library:canonicalize --dry-run --limit=10
php artisan library:canonicalize --force --limit=N  # re-match already-linked rows (e.g. to backfill new columns)
```

Queue wrapper: `App\Jobs\CanonicalizeLibraryJob` (same idiom as `CitationPipelineJob`).

## The auto-version tool — `library:create-auto-versions`

`App\Console\Commands\CreateAutoVersionsCommand`.

For each canonical with `pdf_url IS NOT NULL AND auto_version_book IS NULL`:

1. Find or create a stub library row carrying the canonical's metadata + `pdf_url`, marked `conversion_method = 'pdf_ocr_auto_raw'`, `foundation_source = 'canonical_pdf_vacuum'`, `creator = 'canonicalizer_v1'`, `listed = false`.
2. Dispatch `citation:vacuum {newBookId}` to download the PDF.
3. Dispatch `citation:ocr {newBookId}` to Mistral-OCR it into nodes.
4. Only after OCR succeeds, set `canonical.auto_version_book = newBookId`.

**Idempotent on retry.** If a stub already exists from a failed previous run, it's reused (no duplicate stubs). If the stub already has `has_nodes = true` (OCR completed elsewhere), the canonical pointer is wired and the command moves on.

Usage:
```
php artisan library:create-auto-versions --canonical=<id>   # one canonical
php artisan library:create-auto-versions --limit=10         # batch
php artisan library:create-auto-versions --skip-ocr         # vacuum only, OCR later
php artisan library:create-auto-versions --dry-run
```

## Authorships & identity verification

Canonicals created via the OpenAlex API carry an `authorships` JSONB column holding a structured author list:

```json
[
  {"name": "John Wieczorek",  "openalex_author_id": "A5001880405", "orcid": "0000-0003-1144-0290", "position": "first",  "is_corresponding": false},
  {"name": "David Bloom",     "openalex_author_id": "A5021961456", "orcid": "0000-0003-1273-1807", "position": "middle", "is_corresponding": true},
  {"name": "Stan Blum",       "openalex_author_id": "A5066048686", "orcid": null,                  "position": "middle", "is_corresponding": false}
]
```

Coverage: OpenAlex returns ORCID where the author has registered one (typically 70–90% of authors on recent works; lower for older works). When ORCID is missing, `name` and `openalex_author_id` are still useful identity anchors.

GIN-indexed, so future ORCID lookups can be efficient — e.g.:

```sql
SELECT id, title FROM canonical_source
WHERE authorships @> '[{"orcid": "0000-0003-1144-0290"}]'::jsonb;
```

**Future identity-verification flow this enables:**
1. User connects ORCID to their Hyperlit profile (e.g. via ORCID OAuth).
2. When that user uploads a library row that matches a canonical, the matcher cross-checks the canonical's `authorships[].orcid` against the user's verified ORCID.
3. If a hit: set `library.is_publisher_uploaded = true` and `canonical.author_version_book = newBookId`. The version is now the "official author's version" without manual admin action.
4. UI badge: "Verified author upload."

Until ORCID OAuth ships, the column sits dormant but pre-populated for the canonicals that came through OpenAlex.

## What's still in flight

These are documented here as anchors, not promises:

- **Credibility scoring algorithm.** The `credibility_score` column exists but no algorithm fills it yet. Expected inputs: uploader's commoner score (when users get that), `is_publisher_uploaded`, `human_reviewed_at`, engagement signals (highlights, citations, views), divergence between `canonical_match_score` and `canonical_metadata_score`.
- **Commoner score on users.** No `users.commoner_score` column yet. When added, library rows' credibility will look it up via `creator`.
- **ORCID OAuth on user profiles.** Once users can connect their ORCID, the matcher can cross-reference `canonical_source.authorships[].orcid` against the uploader's verified ORCID and auto-set `is_publisher_uploaded` + `author_version_book` (see *Authorships & identity verification* above).
- **Authorships backfill on "promote"-path canonicals.** Canonicals created via `promote_openalex_metadata` (i.e., the library row already had `openalex_id`, no API call was made) currently have `authorships = NULL`. A follow-up command can iterate those, refetch from OpenAlex by `openalex_id`, and populate `authorships`. Same goes for refreshing Open Library / Semantic Scholar canonicals via their DOI when available.
- **Publisher-verification flow.** `is_publisher_uploaded` and `verified_by_publisher` are columns waiting for a verification UI. For now, admin-set only.
- **Source-container UX.** Currently the book page's source panel does not surface canonical_source / version distinction. Once the data is dense enough, the UI can show "Other versions of this work" and "this version's credibility."
- **Home-page dedup by canonical.** Today two library rows for the same work both appear in listings. A follow-up pass to `HomePageServerController` can collapse by `canonical_source_id` and surface the best version per canonical.
- **Bibliography pipeline integration.** `CitationScanBibliographyJob` currently writes headless library stubs for unmatched external citations. It will eventually write canonical_source rows directly instead.
- **Duplicate-canonical merge tool.** No UNIQUE constraints on `canonical_source.doi` / `openalex_id` yet, so duplicates can accumulate. A merge tool ships when the matcher pipeline is integrated.
- **Library column cleanup.** Display-only columns duplicated in `bibtex` (`note`, `school`, `pages`, `url`, `volume`, `issue`) are candidates for deletion in a separate audit-then-drop PR.
