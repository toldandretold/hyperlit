# How search stays fast (and why it runs on the admin DB connection)

**Deploy: nothing manual.** `git pull`, `php artisan migrate`, `php artisan config:cache` as usual. This file documents the one non-obvious architectural decision in the search stack so future-you doesn't have to rediscover it.

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

## FAQ

**Does the bypass connection expose private books in search?** No. The visibility filters live in the queries themselves and are test-locked. One nuance: the `has_version` flag on a citation-search result may count versions the caller couldn't open (e.g. someone's private copy) — clicking through is still gated at read time by `CanonicalSourceController`, which is unchanged and fully RLS-protected.

**Why not make the app role BYPASSRLS or turn RLS off?** That would remove the safety net everywhere. RLS exists to catch the app's own bugs (a forgotten WHERE clause, an injection); scoping the bypass to three read-only, explicitly-filtered queries keeps that protection for the other 99% of the app.

**What if search ever moves back to the app connection?** It will get slow again (that's the RLS/LEAKPROOF wall), and `search:profile --role=both` will show a huge app-vs-admin gap pointing straight at it. On self-hosted Postgres with a real superuser you could alternatively stamp the functions: `ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) LEAKPROOF; ALTER FUNCTION pg_catalog.ts_match_qv(tsquery, tsvector) LEAKPROOF;` — but as long as prod is on managed Postgres, keep dev unstamped for parity.
