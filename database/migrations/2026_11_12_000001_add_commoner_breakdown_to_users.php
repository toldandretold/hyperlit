<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * The commoner score's per-source COUNTS, stored beside the total, so the Stats
 * overlay's Tillage chart reads one row instead of recomputing on every open.
 *
 * The live breakdown ran ConnectionCountQuery's citation-edge scan twice (in and
 * out) — and that scan builds every reference edge from the whole bibliography
 * and footnotes tables before narrowing to the user's books, so it cost the same
 * for a one-book user as for a prolific one (~300ms locally, seconds on prod),
 * on every Stats open. The stats are a daily picture, not a live feed: the
 * nightly `commoner:recompute` (plus the suggestion-resolve hook) writes these,
 * and the endpoint only computes on demand for a user who has never been
 * computed.
 *
 * commoner_breakdown: {source key => count}; absent keys are 0. NULL = never
 * computed. Counts, not hectares — the weights stay in CommonerScoreService, so
 * a weight change re-weights every stored breakdown at read time without a
 * recompute (the stored commoner_score total catches up on the next run).
 *
 * Like commoner_score, NOT in auth_lookup_user_by_id's column list: read only
 * via pgsql_admin by the service.
 */
return new class extends Migration
{
    protected $connection = 'pgsql_admin';

    public function up(): void
    {
        Schema::connection('pgsql_admin')->table('users', function ($table) {
            $table->jsonb('commoner_breakdown')->nullable()->after('commoner_score');
            $table->timestampTz('commoner_computed_at')->nullable()->after('commoner_breakdown');
        });
    }

    public function down(): void
    {
        Schema::connection('pgsql_admin')->table('users', function ($table) {
            $table->dropColumn(['commoner_breakdown', 'commoner_computed_at']);
        });
    }
};
