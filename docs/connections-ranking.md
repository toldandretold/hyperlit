# Connections & ranking: how Most Connected / Most Lit actually work

This explains why a book does or doesn't surface in the ranking feeds — the homepage's Most Connected / Most Lit tabs, and the `connected` / `lit` sorts on shelf and user-library renders. The single source of truth for all of it is `App\Services\Connections\ConnectionCountQuery`: it computes the scores (`recompute()`) and defines the sort order (`sortConnected()` / `sortLit()`), and every feed delegates to it. That "one definition" rule is a review gate (see CLAUDE.md §Connectedness) enforced by `tests/Feature/Architecture/ConnectionScoreSingleDefinitionTest.php`; the counting rules themselves are locked one-per-test in `tests/Feature/Connections/ConnectionCountQueryTest.php`.

## What counts as a connection

A connection is an edge between two DIFFERENT books in the docuverse. Two edge families, scored separately into two `library` columns:

- **`hypercite_connections`** — minted hypercites. A hypercite row lives on the CITED book; the citing side is the `↗` link inside its `citedIN`. Both directions count: being quoted (inbound) and quoting (outbound).
- **`reference_connections`** — bibliography references whose `foundation_source` resolved to a book actually held on Hyperlit. Also both directions: being referenced and referencing.

The rules applied to every edge, in plain terms:

- **Distinct counterparts, not raw edges.** Five hypercites of the same book from one other book = ONE connection. Quoting a book a hundred times moves the needle exactly once; connections measure *how many different texts* you're entangled with, not how enthusiastically.
- **Inbound is worth double** (`INBOUND_WEIGHT = 2`, `OUTBOUND_WEIGHT = 1`). Being cited is the one direction you cannot self-inflate.
- **Sub-books roll up to their parent.** A hypercite made inside `capital/HL_...` (a highlight or footnote sub-book) belongs to `capital` for counting purposes — on BOTH ends of the edge.
- **Self-loops score nothing.** After rollup, a book citing itself (including citing itself from inside its own highlights/footnotes) is a self-loop and is dropped.
- **Same-real-owner edges score nothing.** If the same user created both endpoint books, the edge is dropped — you cannot raise your own books' connectedness by citing them from your other books. This is deliberately stricter than "a book citing itself": it also kills ring-citing between one user's uploads. The one exemption is the harvested commons corpus — every auto-harvested article shares `AutoVersionResolver::CREATOR`, so journal↔journal edges DO count (otherwise the entire journal graph would be one "owner" and score zero).
- **Both endpoints must be public and have content** (`visibility = public` AND `has_nodes = true`). An edge to a private book or a contentless stub is not a docuverse connection.
- **`foundation_source = 'unknown'` is a sentinel, not a target.** Unresolved references connect to nothing.

## The three rankings

- **Most Connected** — `sortConnected()`: primary key `hypercite_connections` descending, secondary key `reference_connections` descending, final tiebreak `created_at` newest-first. The two-key design means any text with even one minted hypercite edge outranks every text with none; below that line, the machine-detected reference edges decide.
- **Most Lit** — `sortLit()`: `hypercite_connections + total_highlights` descending, tiebreak `created_at` newest-first. This is HUMAN annotation activity — hyperlights (including your own on your own book) plus hypercite edges. Reference edges are deliberately excluded so Lit says something different from Connected.
- **Most Recent** — `created_at` newest-first (plus one hand-pinned book at position 1 on the homepage).

The homepage feeds additionally rank only books that are `listed = true`, not private/deleted, and not sub-books. Shelf and user-library sorts rank whatever the shelf/library contains.

## "I hypercited X lots and it isn't ranking" — the checklist

Work through these in order; the first three cover almost every case:

- **Are you citing it from your own book?** Same-real-owner edges are dropped. Citing *Capital* from your own notes book — when you also uploaded *Capital* — scores zero, no matter how many hypercites you mint. Someone ELSE has to cite it (or it has to cite/be cited by books you don't own).
- **Are you citing it from inside its own highlights/footnotes?** Sub-books roll up: a hypercite of `capital` made inside `capital/HL_...` is `capital → capital` after rollup — a self-loop, dropped.
- **Many hypercites, one counterpart?** Distinct counterparts only: fifty quotes from one book = 1 connection (×2 if inbound).
- **Is either endpoint private, deleted, or contentless?** Both sides must be public with `has_nodes`.
- **Is the book `listed`?** The homepage feeds only rank listed books (shelf sorts don't care).
- **Is it just the cache?** See below.

A real worked example (dev DB): `capital` had 6 hypercite rows and still scored `hypercite_connections = 0` — five edges were cited-in from `capital`'s own highlight sub-books (self-loops after rollup) and the sixth came from another book by the same creator (same-owner drop). Meanwhile its 11 hyperlights DO count toward Most Lit — highlights have no ownership rule.

## Freshness: when a score change becomes visible

Scores and feeds are cached at different layers, so a new hypercite is not instantly visible:

- **Homepage feeds** (`most-recent` / `most-connected` / `most-lit`) are pre-materialised card-books in `nodes`, rebuilt every 15 minutes by `UpdateHomepageJob` (or on demand: `php artisan homepage:update`). The rebuild runs `recompute()` corpus-wide first, so the served order is always consistent with the columns.
- **Shelf / user-library ranking sorts** are rendered card-books (`shelf_{id}_{sort}[_pub]`, `{user}_{vis}_{sort}`) that expire after 900 seconds (`ConnectionRefresher::RENDER_TTL_SECONDS`) — only the `connected`/`lit` variants; stable sorts cache until the shelf is mutated.
- **Minting or removing an edge** should call `ConnectionRefresher::refresh([...])` once per request — it recomputes the affected books and flushes the shelf renders containing them, so those feeds update immediately rather than waiting out the TTL.
- **The client caches feeds in IndexedDB** like any book, revalidated against `library.timestamp` — the server-side rebuild bumps the timestamp, which is what makes an open browser refetch.

## Code map

- `app/Services/Connections/ConnectionCountQuery.php` — scores (`recompute()`, set-based SQL) + sorts (`sortConnected()` / `sortLit()`) + the weights (`INBOUND_WEIGHT` / `OUTBOUND_WEIGHT`).
- `app/Services/Connections/ConnectionRefresher.php` — targeted recompute + render flush on mint; `cachedRenderIsStale()` TTL rule.
- `app/Http/Controllers/HomePageServerController.php` — homepage feed builder (delegates ranking and card HTML).
- `app/Http/Controllers/ShelfController.php` / `UserHomeServerController.php` — shelf and user-library renders (the `connected`/`lit` match arms delegate).
- `php artisan library:recompute-connections` — full backfill/re-run after a rule or weight change.
- Behaviour locks: `tests/Feature/Connections/ConnectionCountQueryTest.php` (one test per counting rule — the fastest way to read the rules as executable examples), `ConnectedFeedOrderTest.php` (feed order end-to-end), `tests/Feature/HomepageFeedsTest.php` (homepage delegation).
