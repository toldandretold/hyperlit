# Load probes (`tests/load/`)

Standalone concurrency probes for answering *"what happens when many users hit
this at once?"* — the empirical companion to the in-process API tests.

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
   the backend. So a one-machine probe measures the *rate limiter*, not capacity.
   To measure real capacity you must either run against a build with throttling
   relaxed, distribute the load across IPs, or target the race below (which fits
   under the budget).
2. **The throttle is per-IP, so it does NOT protect shared resources from many
   *legitimate* users.** N real users = N budgets. That's why **F12 (cache
   stampede) is the headline multi-user risk**, not raw RPS — it fires at ~10–25
   concurrent on a cold cache, *under* one IP's 60/min budget.

## Reproducing F12 (cache stampede → 500s)

F12 (`docs/api-restructure-findings.md#f12`) needs a **cold** cache at the moment
of the burst, so clear the synthetic rebuild rows on the server's DB first, then
burst a modest concurrency (stays under the throttle):

```bash
# Public shelf render (unauthenticated). Default sort is 'recent'.
psql "$DATABASE_URL" -c "DELETE FROM nodes WHERE book = 'shelf_<shelfId>_recent_pub';"
php tests/load/loadprobe.php "http://hyperlit.test/api/public/shelves/<shelfId>/render" --levels 1,15

# Homepage (needs a token + clearing the 3 global synthetic books):
psql "$DATABASE_URL" -c "DELETE FROM nodes WHERE book IN ('most-recent','most-connected','most-lit');"
php tests/load/loadprobe.php http://hyperlit.test/api/homepage/books \
    --header "Authorization: Bearer <token>" --levels 1,15
```

A non-zero **5xx** column on the cold burst (and 0 at concurrency 1) confirms the
unique-index collision under concurrent rebuild. The fix is a single-flight lock
around the rebuild (same `Cache::lock` primitive as the F1/F2 fix).
