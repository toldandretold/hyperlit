# Content maintenance commands (the artisan repair toolbox)

The data-repair / backfill artisan commands you run **on the droplet** to fix book *content* — nodes, plainText, embeddings, footnotes, hyperlights, hypercites, and the library/canonical rows behind them. This is the "where did I put that command" index, mirroring `../supervisor/README.md` (which covers the queue workers these commands feed).

Where to run them:

```bash
ssh marx@170.64.145.89
cd /var/www/hyperlit
php artisan <command> ...
```

Three rules that apply to nearly all of them:

- **Dry-run first.** Most support `--dry-run` (or print a confirm prompt). Always preview the row count before writing.
- **They bypass RLS where it matters.** Artisan has no logged-in user, so a command on the default `pgsql` connection sees only what RLS allows (often nothing). The ones that repair *all* books connect via `pgsql_admin` (BYPASSRLS) — noted per-command below. `embeddings:backfill` is the exception: it deliberately scopes to **public** books only.
- **Some just enqueue work.** Anything that dispatches jobs (embeddings, especially) only queues them — the matching queue worker (`hyperlit-embeddings` etc., see `../supervisor/README.md`) must be running for the work to actually happen.

---

## The one that keeps coming up: missing plainText → missing embeddings

**Symptom:** a book's nodes have empty `plainText` and no vector `embedding`, even though `content` is full and full-text search still works.

**Why it happens:** the client never sends a `plainText` field. The backend derives it (`strip_tags(content)`) — but the primary live-edit path (`/api/db/unified-sync` → `bulkTargetedUpsert`) historically did *not*, and its `ON CONFLICT DO UPDATE SET "plainText" = EXCLUDED."plainText"` overwrote any previously-derived value with `NULL` on every re-sync (a footnote renumber or bulk highlight op can wipe a whole book at once). Embeddings only queue nodes `WHERE plainText IS NOT NULL AND LENGTH(TRIM(plainText)) >= 20`, so a nulled `plainText` node is skipped forever. (Search survives because the tsvector columns derive from `content` via a DB trigger, independent of `plainText`.) The forward fix lives in `app/Http/Controllers/DbNodeController.php` (`batchUpsertByNodeId` / `batchUpsertByStartLine` now derive plainText like `upsert()` does).

**The fix for already-broken books — one command:**

```bash
php artisan nodes:backfill-plaintext book_1768985059406 --dry-run   # preview: how many nodes?
php artisan nodes:backfill-plaintext book_1768985059406             # fill plainText + re-queue embeddings
php artisan nodes:backfill-plaintext                                # …or every affected book
```

`nodes:backfill-plaintext` uses the `pgsql_admin` connection (covers **private** books too) and, after filling `plainText`, dispatches `QueueBookEmbeddings` per affected book. Then make sure the embeddings worker drains it:

```bash
./deploy/supervisor/workers.sh status          # is hyperlit-embeddings RUNNING?
./deploy/supervisor/workers.sh backlog         # watch the embeddings queue drain
```

Verify:

```sql
-- should drop to only genuinely short/empty nodes
SELECT count(*) FROM nodes WHERE book = 'book_1768985059406' AND embedding IS NULL;
SELECT count(*) FROM nodes WHERE book = 'book_1768985059406' AND ("plainText" IS NULL OR TRIM("plainText") = '');
```

Flags: `--dry-run` (preview), `--force` (regenerate even where plainText is already set), `--no-embed` (skip the embedding dispatch).

### The two embedding/plainText commands, and which to reach for

| Command | Scope | What it does | Use when |
|---|---|---|---|
| `nodes:backfill-plaintext [book]` | all books (admin conn, incl. private) | `plainText = strip_tags(content)` where empty, then dispatches `QueueBookEmbeddings` per book | plainText is missing (the usual root cause). This is the fix-it-all. |
| `embeddings:backfill` | **public** books only, non-sub-book | embeds nodes where `embedding IS NULL AND plainText >= 20 chars` | plainText is already present but embeddings never generated (e.g. a public book imported before the embed path existed). |

`embeddings:backfill` flags: `--book=<id>`, `--batch-size=100`, `--limit=<n>`. Note it will **skip** any node whose `plainText` is empty — run `nodes:backfill-plaintext` first if in doubt.

> Known gap (not yet automated): editing a node's *content* does not clear its existing `embedding`, so a stale embedding is never regenerated. To force a refresh today: `UPDATE nodes SET embedding = NULL WHERE book = '<id>'` (via `pgsql_admin`), then `nodes:backfill-plaintext <id>` (or `embeddings:backfill --book=<id>` for public books).

---

## Nodes & content

| Command | What it does | Notes |
|---|---|---|
| `nodes:backfill-plaintext [book]` | Derive `plainText` from `content`; re-queue embeddings | See above. `--dry-run` / `--force` / `--no-embed`. |
| `nodes:renumber <book>` | Force-renumber all nodes in a book with clean IDs and chunk_ids | `--dry-run`. Destructive to ordering — preview first. |
| `content:strip-mark-tags [book]` | Remove `<mark>` tags from the `content` column (highlights are re-injected on page load, so they shouldn't be persisted) | `--dry-run`. |
| `books:migrate-content [book]` | One-time: migrate node IDs + normalize footnotes | Legacy migration; scope to a `book` when re-running. |
| `migrate:embedded-annotations [book]` | Migrate embedded hyperlights/hypercites → normalized `charData` schema | Legacy schema migration. |

## Versioning / restore (per book)

| Command | What it does |
|---|---|
| `book:snapshots <book>` | List version-history snapshots for a book (`--limit=20`) |
| `book:preview <book> --at=<n\|ts>` | Show what the book looked like at a snapshot (read-only) |
| `book:restore <book> --at=<n\|ts>` | Restore a book to a previous version (`--dry-run` to preview) |

## Footnotes / hyperlights / hypercites

| Command | What it does |
|---|---|
| `footnotes:backfill-sub-books` | Create missing sub-book library rows + nodes for pre-existing footnotes. `--dry-run`, `--library-rows-only` (rows only, skip node materialisation — the fix for "500 on a sub-book" RLS chicken-and-egg) |
| `hyperlights:backfill-sub-books` | Same, for pre-existing hyperlights. `--dry-run` |
| `hyperlights:purge-overlap-phantoms` | Delete phantom `HL_overlap` rows (residue of the old overlap-save bug) |
| `hypercite:convert-format` | Convert hypercites to word-joiner format (remove spans, add word joiner before anchors) |
| `hypercite:fix-link-ids` | Fix broken hypercite link IDs using the `citedIN` arrays |
| `hypercite:wrap-arrows` | Wrap hypercite arrows in nowrap spans (prevent orphaning) |
| `hypercites:update-urls` | Replace `libzen.io` / `libzen.com` URLs with `hyperlit.io` in hypercite links |

## Library / canonical sources

See `docs/canonical-sources.md` for the data model. Repair/backfill commands:

| Command | What it does |
|---|---|
| `library:canonicalize` | Match each library row to a `canonical_source` (existing or via OpenAlex) and link them |
| `library:create-auto-versions` | For each canonical with a `pdf_url` and no auto-version: vacuum PDF → OCR → link a system version |
| `library:create-ar5iv-versions` | Same, but mint ar5iv HTML versions for arXiv canonicals |
| `library:reconvert-system-version` | Reconvert a system-owned auto-version in place (keeps book id + canonical pointer) |
| `library:backfill-bib-canonicals` | Copy `canonical_source_id` onto bibliography entries from their foundation library rows |
| `library:backfill-citation-stubs` | Migrate orphan OpenAlex/OpenLibrary stubs into `canonical_source`, clean up `library` |
| `library:backfill-doi` | Extract DOIs from `library.url` into `library.doi` where missing |
| `library:clean-corrupted-json` | Clean recursively-nested `raw_json` in the library table |
| `library:hide-incomplete` | Set `visibility=private` for library entries with NULL author |

## Homepage / user pages

| Command | What it does |
|---|---|
| `homepage:update` | Regenerate homepage ranking books (most-recent, most-connected, most-lit) |
| `users:regenerate-home-pages` | Regenerate every user home book (public/private/all/account) via the canonical controllers |

---

## Adding a new command here

When you write a new content-repair command:

1. Prefer the `pgsql_admin` connection if it must touch private books (artisan has no user context — RLS will otherwise hide rows). Follow `app/Console/Commands/BackfillEmbeddings.php` / `BackfillNodePlainText.php`.
2. Give it a `--dry-run`.
3. If it changes node content/plainText, dispatch `QueueBookEmbeddings::dispatch($book)` for affected books so semantic search stays consistent.
4. Add a row to the right table above (one line: command, what it does, key flags).
