<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * The archive registry: a public "hypertext archive" is a curated public SHELF
 * (fed by scrape-folder drops through /maintainer/shelf-import) plus this row,
 * which gives it a global slug for /a/{slug}, hand-written about copy, and the
 * certified-at human signal that lists it on the homepage. Mirrors the
 * journal_sources → shelf indirection; deliberately tiny — an archive has no
 * OpenAlex/DOAJ machine identity to sync. See docs/web-scrape-import.md.
 *
 * No FK to shelves (consistent with import_batches.shelf_id) — the app checks
 * shelf existence/visibility where it matters.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE archive_sources (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

                shelf_id uuid NOT NULL UNIQUE,
                slug varchar(100) NOT NULL UNIQUE,
                display_name varchar(255) NOT NULL,
                about text NULL,

                certified_at timestamp NULL,

                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement(
            "CREATE INDEX archive_sources_certified_idx ON archive_sources (certified_at) WHERE certified_at IS NOT NULL"
        );

        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON archive_sources TO {$appUser}");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS archive_sources");
    }
};
