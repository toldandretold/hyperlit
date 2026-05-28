<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Adds a GIN-indexed `search_vector` to canonical_source so the citation modal
     * can full-text-search citation identities directly (not just library rows).
     *
     * Weighting mirrors how library.search_vector is used in SearchController:
     *   A = title, B = author, C = journal/publisher, D = abstract.
     * STORED so existing rows are indexed immediately on migration — no backfill.
     * Uses the `simple` config (same as library) so stop words like "the" are kept.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
            ADD COLUMN search_vector tsvector
            GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                setweight(to_tsvector('simple', coalesce(author, '')), 'B') ||
                setweight(to_tsvector('simple', coalesce(journal, '') || ' ' || coalesce(publisher, '')), 'C') ||
                setweight(to_tsvector('simple', coalesce(abstract, '')), 'D')
            ) STORED
        ");

        DB::connection('pgsql_admin')->statement("
            CREATE INDEX canonical_source_search_vector_idx
            ON canonical_source USING gin (search_vector)
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP INDEX IF EXISTS canonical_source_search_vector_idx");
        DB::connection('pgsql_admin')->statement("ALTER TABLE canonical_source DROP COLUMN IF EXISTS search_vector");
    }
};
