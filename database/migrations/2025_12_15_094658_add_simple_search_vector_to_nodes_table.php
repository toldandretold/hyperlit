<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     * Adds a second search_vector column using 'simple' config (no stop words, no stemming)
     * for exact match searching with automatic fallback to 'english' (stemmed) search.
     */
    public function up(): void
    {
        // Add search_vector_simple as a generated column using 'simple' text search config
        DB::statement('
            ALTER TABLE nodes
            ADD COLUMN search_vector_simple tsvector
            GENERATED ALWAYS AS (to_tsvector(\'simple\', COALESCE("plainText", content, \'\'))) STORED
        ');

        // Create GIN index for fast searching
        DB::statement('
            CREATE INDEX nodes_search_vector_simple_idx
            ON nodes USING GIN (search_vector_simple)
        ');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS nodes_search_vector_simple_idx');
        DB::statement('ALTER TABLE nodes DROP COLUMN IF EXISTS search_vector_simple');
    }
};
