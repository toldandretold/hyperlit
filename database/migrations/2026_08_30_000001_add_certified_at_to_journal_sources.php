<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Journal certification: a person has read this journal's conversions and is
 * willing to put it on the homepage. Distinct from `is_diamond`, which is
 * DOAJ's machine-checkable fact about APCs — a journal can be provably diamond
 * and still be half-imported, so the registry needs a separate human signal.
 *
 * A timestamp rather than a boolean so the row records WHEN it was vouched for.
 * The partial index is because the homepage query runs on every request while
 * the certified set is a tiny slice of a registry that holds thousands of rows
 * after a full `journal:sync-registry`.
 *
 * No GRANT needed: the create migration granted the app user table-level
 * SELECT/INSERT/UPDATE/DELETE, which covers new columns.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE journal_sources
                ADD COLUMN certified_at timestamp NULL
        ");

        DB::connection('pgsql_admin')->statement("
            CREATE INDEX journal_sources_certified_idx
                ON journal_sources (certified_at)
                WHERE certified_at IS NOT NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP INDEX IF EXISTS journal_sources_certified_idx");
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE journal_sources
                DROP COLUMN IF EXISTS certified_at
        ");
    }
};
