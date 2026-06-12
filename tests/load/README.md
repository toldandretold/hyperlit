# Load probes (`tests/load/`)

Standalone concurrency probes for answering *"what happens when many users hit
this at once?"* — the empirical companion to the in-process API tests.

There are TWO layers to probe, with different tools:

| Layer | Tool | What it catches |
|-------|------|-----------------|
| HTTP (requests) | `loadprobe.php` (this dir) | rate limiters, cache stampedes (F12), 5xx under burst |
| Queue (workers) | `php artisan queue:probe` | one job class head-of-line-blocking another; queues nobody serves; missing standby import workers |
| RAM (job peaks) | `memprobe.sh` (this dir) | whether the box can AFFORD the parallelism the topology allows |

## RAM probe (`memprobe.sh`)

Samples the RSS of one or more process TREES (php + python/pandoc children) once
per second until they exit; reports per-tree and combined peaks. Run the real
heavy jobs concurrently and point it at their PIDs (`label:pid` pairs). To run a
real import without Mistral API cost, copy an existing book dir's `original.pdf`
+ `ocr_response.json` (the OCR step reuses the cache) under a new bookId, insert
a library row, then `ProcessDocumentImportJob::dispatchSync(...)` via tinker.

Measured 2026-06-12 (Apple Silicon dev box, but RSS is data-driven and
indicative for the droplet). Per-class peaks, real jobs:
- import, 700-page handbook → 9.7k nodes: **212 MB**
- citation pipeline, 230 refs, full review+verify: **200 MB**
- vibe conversion (mock-diff = no LLM wait, full sandbox+reconvert+gate): **182 MB**
- embeddings worker: **50 MB**

ALL FOUR job classes genuinely simultaneous (vibe+import fired during citation's
review phase): **521 MB combined peak**; worst-case arithmetic sum **~645 MB**.

Tricks to make real runs free: imports reuse a copied `ocr_response.json` (OCR
step skips the API); vibe takes `--mock-diff <patch.json>` (a verbatim no-op
function replacement skips the LLM but still does sandbox copy + full
re-conversion + gate — the memory-heavy parts).

Caveats — the two unmeasured tails:
- the citation run used `--skip-fetch`: a live vacuum phase launches headless
  chromium per fetch (~150–300 MB transient), so the citation tree can spike to
  ~450 MB and the all-four worst case toward ~900 MB during vacuum;
- image-heavy scanned PDFs: the live OCR fetch holds the page JSON (with base64
  images) in Python, which the cached run skips.

## Queue topology probe (`php artisan queue:probe`)

The Pest suite runs jobs synchronously and `loadprobe.php` never touches workers,
so neither can see the failure mode where a 15-minute citation pipeline blocked
every document import (both shared one serial worker, and citation OUTRANKED
imports). `queue:probe` tests exactly that, empirically: it occupies EVERY queue
at once with synthetic sleep jobs (no real imports/LLM calls) and verifies

1. every queue has a worker (a queue nobody serves = jobs silently never run),
2. all queues run in parallel (start-time spread < blocker duration),
3. a fresh import still starts immediately while the first import worker AND
   every other queue are busy (the standby worker).

```bash
php artisan queue:probe                 # hermetic: spawns the reference topology itself
php artisan queue:probe --use-running   # test whatever workers are up right now (e.g. dev:all)
```

Exit 0 = topology OK, 1 = broken — CI-able. Verified both ways 2026-06-12:
the per-queue topology passes; a single `php artisan work` worker fails it.
Note `--use-running` results are only meaningful if you know what's running:
extra stray workers (an old dev stack, a forgotten shell) will pick up probe
jobs and muddy the verdict — the hermetic default has no such problem.

**These are NOT Pest tests, on purpose.** The Pest suite binds `RefreshDatabase`
to everything under `tests/Feature/`, and this project has no `.env.testing` +
commented-out `DB_DATABASE` in `phpunit.xml` — so **`php artisan test` runs
`migrate:fresh` on `.env`'s `my_laravel_db`, the same database Herd serves.** A
Pest-based load test pointed at a running server would therefore *wipe the
server's database* before the skip check even runs. `loadprobe.php` boots no
framework and opens no DB connection, so it is safe to point at a live server.

> ⚠️ Corollary: never point a `Feature/` test (incl. the `--group=concurrency`
> harness) at a server whose DB you care about — running it migrate:fresh's that
> DB. Give the test runner its own throwaway DB (`.env.testing`), or only
> load-test with `loadprobe.php`.

## Usage

```bash
# Capacity curve of a public read endpoint:
php tests/load/loadprobe.php http://hyperlit.test/api/vibes/public

# Custom concurrency levels + requests per level:
php tests/load/loadprobe.php <url> --levels 1,10,25,50 --per-level 60

# Authenticated endpoint:
php tests/load/loadprobe.php http://hyperlit.test/api/homepage/books \
    --header "Authorization: Bearer <token>"
```

Per concurrency level it prints reqs, 2xx / 4xx / 5xx-or-error counts, p50/p95/p99/
max latency, and throughput. **Rising p95/max** = saturation; a **climbing 5xx/err
column** = the endpoint failing under load.

## What the first run taught us (read this)

Probing `/api/vibes/public` showed all-2xx at concurrency 1, then a wall of **4xx**
at 5+. That's the **`throttle:60,1` rate limiter** (60 req/min/IP) returning 429s —
the limiter working. Two consequences:

1. **A single IP can't stress these endpoints** — you hit the throttle long before
   the backend, so a naive one-machine probe measures the *rate limiter*, not
   capacity. **Solution: `--ip-spread`.** The app trusts proxy headers
   (`trustProxies '*'`) and the limiter keys off `$request->ip()`, so sending a
   distinct `X-Forwarded-For` per request gives each request its own throttle
   bucket — one machine simulating N distinct users:

   ```bash
   php tests/load/loadprobe.php http://hyperlit.test/api/vibes/public --ip-spread
   ```

   With `--ip-spread` the 429 wall disappears and you see the real curve (p50
   climbing with concurrency = genuine saturation). ⚠️ Controlled load
   environments only — never spoof `X-Forwarded-For` against production.
2. **The throttle is per-IP, so it does NOT protect shared resources from many
   *legitimate* users.** N real users = N budgets. That's why **F12 (cache
   stampede) is the headline multi-user risk**, not raw RPS — it fires at ~10–25
   concurrent on a cold cache, *under* one IP's 60/min budget.

## Reproducing F12 (cache stampede → 500s)

F12 (`docs/api-restructure-findings.md#f12`) needs the rebuild path to be **cold**
at the moment of the burst. "Cold" means *both* the cache key gone *and* the
synthetic node rows deleted — clearing only one short-circuits the rebuild you're
trying to race. Clear via `tinker` (handles the cache key; and the node rows live
behind RLS, so they must be cleared through the `pgsql_admin` BYPASSRLS
connection — the default `pgsql` role can't see them):

### Shelf render (canonical, unauthenticated)

`publicRender` is gated only by `throttle:60,1`, so use `--ip-spread` to simulate
distinct users past the per-IP limit. Its "already rendered?" guard is an
`exists()` on the synthetic node rows, so deleting those rows alone makes it cold.

```bash
# Find a PUBLIC shelf id — shelves are RLS-hidden from the default role, so query
# through pgsql_admin (Shelf::count() under no auth context returns 0; not a bug):
php artisan tinker --execute="DB::connection('pgsql_admin')->table('shelves')->where('visibility','public')->get(['id','default_sort'])->each(fn(\$s)=>print(\$s->id.'  '.(\$s->default_sort??'recent').PHP_EOL));"

# Synthetic book id = shelf_<id>_<sort>_pub. Cold it, then burst distinct users:
SBID="shelf_<id>_recent_pub"
php artisan tinker --execute="DB::connection('pgsql_admin')->table('nodes')->where('book','$SBID')->delete();"
php tests/load/loadprobe.php "http://hyperlit.test/api/public/shelves/<id>/render" --levels 25 --per-level 25 --ip-spread
```

### Homepage (richer surface — real library data)

Two gotchas: (1) `/homepage/books` is behind the `author` middleware, which a
**Bearer token does NOT satisfy** (`RequireAuthor` checks the session guard or an
`anon_token` cookie, not Sanctum) — mint an anon session and replay its cookie;
(2) it caches the payload under `homepage_books_data`, so you must `Cache::forget`
it **and** delete the 3 global synthetic books, else the warm cache is served and
nothing rebuilds.

```bash
# Mint an anon session the SPA way; capture the cookie (single IP — the session is
# IP-bound, max 5 IP changes/day, so do NOT use --ip-spread on this path):
curl -s -c /tmp/hl.txt -X POST http://hyperlit.test/api/anonymous-session >/dev/null
ANON=$(grep anon_token /tmp/hl.txt | awk '{print $NF}')

# Cold the rebuild (cache key + the 3 shared synthetic books), then burst:
php artisan tinker --execute="Cache::forget('homepage_books_data'); DB::connection('pgsql_admin')->table('nodes')->whereIn('book',['most-recent','most-connected','most-lit'])->delete();"
php tests/load/loadprobe.php http://hyperlit.test/api/homepage/books \
    --header "Cookie: anon_token=$ANON" --levels 40 --per-level 40
```

### Reading the result

A non-zero **5xx** column on the cold burst (and 0 at concurrency 1) confirms the
unique-index collision under concurrent rebuild. **Post-fix (verified 2026-06-09):
all-2xx** up to 40 concurrent on the homepage and 25 distinct users on the shelf,
with p50 ≈ one rebuild's duration at *every* concurrency level — the single-flight
`Cache::lock` signature: one caller rebuilds, the rest block then read the warm
result instead of colliding. Confirm no half-built state afterwards:

```bash
php artisan tinker --execute="echo DB::connection('pgsql_admin')->table('nodes')->where('book','$SBID')->select('node_id')->groupBy('node_id')->havingRaw('count(*)>1')->get()->count().' duplicate node_ids';"
```
