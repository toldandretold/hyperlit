<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Phase 1 of the raw_json phase-out (docs: plan im-trying-to-do-lazy-bubble).
 *
 * `nodes.raw_json` was a denormalized JSONB copy of the whole node row — the read
 * API reconstructs the same shape from the canonical columns (content / plainText /
 * type / footnotes), so nothing needs it. It was the single biggest slice of the
 * nodes table (~1.5 GB locally). `nodes.raw_json` has NO RLS or index dependency
 * (the nodes RLS policies reference library.raw_json, never their own).
 *
 * nodes_history mirrors nodes and the temporal `versioning()` trigger column-matches
 * by name, so the history copy MUST be dropped in the same step or every node write
 * would fail. Space only returns after VACUUM FULL (run separately).
 *
 * Run with admin privileges: php artisan migrate --database=pgsql_admin
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('ALTER TABLE nodes DROP COLUMN IF EXISTS raw_json');
        DB::connection('pgsql_admin')->statement('ALTER TABLE nodes_history DROP COLUMN IF EXISTS raw_json');
    }

    public function down(): void
    {
        // Re-add nullable — the original denormalized data cannot be reconstructed.
        DB::connection('pgsql_admin')->statement('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS raw_json JSONB');
        DB::connection('pgsql_admin')->statement('ALTER TABLE nodes_history ADD COLUMN IF NOT EXISTS raw_json JSONB');
    }
};
