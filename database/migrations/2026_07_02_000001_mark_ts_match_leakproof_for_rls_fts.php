<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Mark the full-text-search match functions LEAKPROOF so GIN indexes work
 * under row-level security.
 *
 * WHY: with RLS active, the planner may only push a user qual below the
 * policy barrier if its function is LEAKPROOF. tsvector @@ tsquery
 * (pg_catalog.ts_match_vq) ships as NOT leakproof, so on RLS-forced tables
 * (nodes, library) the GIN search_vector indexes were UNUSABLE for the app
 * role — every /api/search/nodes query degraded to a seq scan / nested loop
 * with the policy EXISTS evaluated per row (measured: 1.4-8.7s on the 2.2M-row
 * nodes table for a zero-match query vs ~15ms with the index; see
 * `php artisan search:profile "<q>" --analyze --role=both`).
 *
 * SECURITY TRADEOFF (accepted): LEAKPROOF asserts the function cannot reveal
 * anything about its arguments other than the return value. Postgres core
 * leaves ts_match unmarked out of caution about theoretical side channels
 * (timing, internal errors) — not because of any known content leak. Marking
 * it is the standard, widely-deployed workaround for RLS + FTS. Row output is
 * still fully policy-filtered; the residual risk is a timing side channel on
 * rows the caller cannot see, which this product accepts.
 *
 * Requires a role that owns pg_catalog functions (superuser) — runs on the
 * pgsql_admin connection like the other RLS migrations. If the production
 * admin role is not superuser, run the two ALTERs manually as the DB
 * superuser and mark this migration as run.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Idempotent: if a DBA already ran the ALTERs by hand (required when
        // pgsql_admin is not superuser — pg_catalog functions are owned by
        // postgres), this records the migration as run without touching anything.
        if ($this->alreadyLeakproof()) {
            return;
        }

        try {
            // tsvector @@ tsquery (the shape every search query uses)
            DB::connection('pgsql_admin')->statement(
                'ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) LEAKPROOF'
            );
            // tsquery @@ tsvector (symmetric operator, for completeness)
            DB::connection('pgsql_admin')->statement(
                'ALTER FUNCTION pg_catalog.ts_match_qv(tsquery, tsvector) LEAKPROOF'
            );
        } catch (\Illuminate\Database\QueryException $e) {
            if ($e->getCode() === '42501') { // insufficient_privilege
                throw new \RuntimeException(
                    "pgsql_admin cannot alter pg_catalog functions (not superuser).\n" .
                    "Run ONCE as the postgres superuser against THIS database, then re-run `php artisan migrate`:\n\n" .
                    "  sudo -u postgres psql -d <your-db-name> -c \"ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) LEAKPROOF; ALTER FUNCTION pg_catalog.ts_match_qv(tsquery, tsvector) LEAKPROOF;\"\n\n" .
                    "The migration will then detect the functions are already leakproof and record itself as run.",
                    0,
                    $e
                );
            }
            throw $e;
        }
    }

    private function alreadyLeakproof(): bool
    {
        $rows = DB::connection('pgsql_admin')->select(
            "SELECT proname, proleakproof FROM pg_proc WHERE proname IN ('ts_match_vq', 'ts_match_qv')"
        );

        $status = [];
        foreach ($rows as $row) {
            $status[$row->proname] = (bool) $row->proleakproof;
        }

        return ($status['ts_match_vq'] ?? false) && ($status['ts_match_qv'] ?? false);
    }

    public function down(): void
    {
        if (!$this->alreadyLeakproof()) {
            return; // already reverted (or never applied)
        }

        try {
            DB::connection('pgsql_admin')->statement(
                'ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) NOT LEAKPROOF'
            );
            DB::connection('pgsql_admin')->statement(
                'ALTER FUNCTION pg_catalog.ts_match_qv(tsquery, tsvector) NOT LEAKPROOF'
            );
        } catch (\Illuminate\Database\QueryException $e) {
            if ($e->getCode() === '42501') {
                throw new \RuntimeException(
                    "pgsql_admin cannot alter pg_catalog functions (not superuser). Revert as postgres:\n" .
                    "  sudo -u postgres psql -d <your-db-name> -c \"ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) NOT LEAKPROOF; ALTER FUNCTION pg_catalog.ts_match_qv(tsquery, tsvector) NOT LEAKPROOF;\"",
                    0,
                    $e
                );
            }
            throw $e;
        }
    }
};
