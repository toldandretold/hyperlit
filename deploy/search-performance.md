# How search stays fast (and why it runs on the admin DB connection)

This file documents the non-obvious decisions in the search stack so future-you doesn't have to rediscover them, plus the deploy steps.

## Deploy checklist

Routine deploys are the usual `git pull` → `migrate` → `config:cache` → `./deploy/supervisor/workers.sh restart`. **One-time on the deploy that introduces the `search-supplement` queue** (the citation modal's external-ingest worker — without this step nothing listens on the queue and supplements silently never run):

```bash
cd /var/www/hyperlit && git pull
sudo cp deploy/supervisor/hyperlit-search.conf /etc/supervisor/conf.d/
sudo supervisorctl reread && sudo supervisorctl update
sudo -u www-data php artisan migrate
sudo -u www-data php artisan config:cache
./deploy/supervisor/workers.sh restart
./deploy/supervisor/workers.sh status     # expect all 5 programs RUNNING
```

(Front-end changed too — run your usual `npm run build` step if you build on the server.) Smoke test: type an obscure author in the citation modal — "searching external databases…" should appear, with results folding in within a few seconds. Full worker topology docs: `deploy/supervisor/README.md`.

## The problem

Search used to take seconds. The full-text (GIN) indexes on `nodes` and `library` existed and were correct — but Postgres refused to use them. Reason: with row-level security (RLS) active on a table, Postgres only allows a function to run *before* the per-row permission check if that function is stamped `LEAKPROOF` ("cannot leak row contents via errors or side effects"). The built-in text-match function behind `@@` doesn't carry that stamp, so every search fell back to scanning the whole 2M-row `nodes` table with a permission check per row. Seconds per keystroke.

## Why we can't just add the stamp

The stamp requires altering functions in `pg_catalog`, which only the `postgres` superuser may do. Our production database is **DigitalOcean managed Postgres** (`DB_HOST` ends in `ondigitalocean.com`) — nobody gets superuser on managed databases; DO keeps it. `doadmin` is the strongest role available and it cannot modify system functions. So the stamp is permanently unavailable in production, and to keep **dev identical to prod** we deliberately don't apply it locally either (a fast-only-in-dev setup would hide prod slowness).

## The solution: search reads on the BYPASSRLS connection

`doadmin` has the `BYPASSRLS` attribute (verified 2026-07). The app routes its **read-only search queries** — and only those — through the admin connection, where RLS doesn't apply and the GIN indexes work normally. Same in dev and prod.

- Config: `config/database.php` → `search_read_connection` (default `pgsql_admin`, env override `DB_SEARCH_CONNECTION` — don't set it unless you know why).
- Code: `SearchService::searchConnection()` + the two query sites in `SearchController`.
- Tests pin it to the normal `pgsql` connection (phpunit.xml) so search reads see rows seeded inside `RefreshDatabase`'s per-test transaction.

**Why this is safe:**

- Every search query enforces visibility **explicitly in its SQL** — public+listed books, plus the caller's own books, plus shelf members for shelf scope. These clauses are *stricter* than the RLS policies and fully parameterized.
- The privacy contract is test-locked: `tests/Feature/Citations/CitationSearchTest.php` (private books excluded from public scope, scope/cache isolation) and `tests/Feature/AiBrain/RetrievalScopeTest.php`.
- RLS remains fully enforced for **everything else** — all writes, all non-search reads, the whole app. This is the narrowest possible carve-out: three read-only SELECT shapes.

## Verifying search performance (any environment)

```bash
# EXPLAIN ANALYZE of the exact production query shapes; admin role = what search actually uses
sudo -u www-data XDG_CONFIG_HOME=/tmp HOME=/tmp php artisan search:profile "marx capital" --analyze --role=admin
```

Expect tens of milliseconds on the `nodes` rows. (`--role=app` shows the RLS-enforced plans — expect those to be slow; that's precisely why search doesn't use that connection. The gap between the two roles is the RLS cost, useful for diagnosis.)

Live latency dashboard (from your machine, against any running server):

```bash
HYPERLIT_TEST_URL=https://your-server php artisan test --group=concurrency --filter=SearchLatency
```

And every `/api/search/*` response carries a `Server-Timing` header (browser devtools → Network) showing per-stage cost in production, permanently.

## How external supplementation behaves (citation modal)

When a public citation search returns fewer than 15 local results, the server queues `IngestExternalCitationCandidatesJob` (OpenAlex + Open Library → `canonical_source`) and responds `external_pending: true`. The modal shows "No local results — searching external databases…" and automatically re-checks up to 3 times at 2.5s intervals, folding new results in as soon as the job lands. The "don't re-ask the APIs for this query" courtesy window (15 min) starts only when the fetch actually completed — a dead worker holds the query for just 2 minutes, not 15.

Operational notes:

- **Local dev needs a queue worker** (`php artisan queue:work`, or whatever `npm run dev:all` wires) — without one the job sits in the `jobs` table and the modal settles on the plain empty state.
- **Prod:** the job rides its own `search-supplement` queue with a dedicated light worker (`deploy/supervisor/hyperlit-search.conf`, ~50 MB — fits the RAM budget in `deploy/supervisor/README.md`), so it never queues behind a 15-min document import on `default`. First-time install: `sudo cp deploy/supervisor/hyperlit-search.conf /etc/supervisor/conf.d/ && sudo supervisorctl reread && sudo supervisorctl update`.
- **Provider quirks (seen in testing):** OpenAlex intermittently returns 503 (the job degrades to Open Library alone); Open Library returns nothing for author+title mixtures it can't parse. Zero external results for an obscure query can therefore be the sources' fault, not the pipeline's.
- **The user is told the truth about emptiness.** The job records a per-query outcome, surfaced as `external_status` on the search response, and the modal words its empty state accordingly: sources errored with nothing ingested → "external databases are currently unreachable, try again in a few minutes"; job still queued/running → "still searching external databases in the background, try again shortly"; sources answered with genuinely nothing → the plain "No results found".
- **End-to-end proof:** `cd tests/e2e && E2E_EXTERNAL=1 npx playwright test citation-external-supplement` (needs a running worker; hits real APIs). The mocked variants in the same file run without any of that. This spec is what caught the generation-bump cache bug (`Cache::increment` no-ops on missing keys under `CACHE_STORE=database`) that every unit test missed.

## FAQ

**Does the bypass connection expose private books in search?** No. The visibility filters live in the queries themselves and are test-locked. One nuance: the `has_version` flag on a citation-search result may count versions the caller couldn't open (e.g. someone's private copy) — clicking through is still gated at read time by `CanonicalSourceController`, which is unchanged and fully RLS-protected.

**Why not make the app role BYPASSRLS or turn RLS off?** That would remove the safety net everywhere. RLS exists to catch the app's own bugs (a forgotten WHERE clause, an injection); scoping the bypass to three read-only, explicitly-filtered queries keeps that protection for the other 99% of the app.

**What if search ever moves back to the app connection?** It will get slow again (that's the RLS/LEAKPROOF wall), and `search:profile --role=both` will show a huge app-vs-admin gap pointing straight at it. On self-hosted Postgres with a real superuser you could alternatively stamp the functions: `ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) LEAKPROOF; ALTER FUNCTION pg_catalog.ts_match_qv(tsquery, tsvector) LEAKPROOF;` — but as long as prod is on managed Postgres, keep dev unstamped for parity.
