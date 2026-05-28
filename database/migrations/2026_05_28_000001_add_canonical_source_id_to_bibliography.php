<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Adds the canonical_source_id pointer to bibliography records so the click
     * handler can resolve the right library version (or surface a citation-only
     * card) post-PR5. Nullable + indexed; old records continue to use source_id.
     *
     * Not a foreign key (canonical_source rows can be hard-deleted by admin
     * cleanups; we'd rather see a stale pointer logged than block the delete).
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE bibliography
            ADD COLUMN canonical_source_id uuid NULL
        ");

        DB::connection('pgsql_admin')->statement("
            CREATE INDEX bibliography_canonical_source_id_idx
            ON bibliography (canonical_source_id)
            WHERE canonical_source_id IS NOT NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP INDEX IF EXISTS bibliography_canonical_source_id_idx");
        DB::connection('pgsql_admin')->statement("ALTER TABLE bibliography DROP COLUMN IF EXISTS canonical_source_id");
    }
};
