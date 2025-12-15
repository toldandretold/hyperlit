<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Update library search_vector to use 'simple' configuration for title and author.
     *
     * This preserves stop words like "to", "do", "the" which were previously
     * stripped by the 'english' configuration, making titles like "TO DO"
     * and authors with names like "To" searchable.
     */
    public function up(): void
    {
        // Drop the existing generated column and index
        DB::statement('DROP INDEX IF EXISTS library_search_vector_idx');
        DB::statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');

        // Recreate with 'simple' configuration for both title and author
        // 'simple' preserves all words without stop word removal or stemming
        DB::statement("
            ALTER TABLE library
            ADD COLUMN search_vector tsvector
            GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', COALESCE(title, '')), 'A') ||
                setweight(to_tsvector('simple', COALESCE(author, '')), 'B')
            ) STORED
        ");

        // Recreate the GIN index
        DB::statement("
            CREATE INDEX library_search_vector_idx
            ON library USING GIN(search_vector)
        ");
    }

    /**
     * Reverse back to 'english' configuration.
     */
    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS library_search_vector_idx');
        DB::statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');

        // Restore original 'english' configuration
        DB::statement("
            ALTER TABLE library
            ADD COLUMN search_vector tsvector
            GENERATED ALWAYS AS (
                setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
                setweight(to_tsvector('english', COALESCE(author, '')), 'B')
            ) STORED
        ");

        DB::statement("
            CREATE INDEX library_search_vector_idx
            ON library USING GIN(search_vector)
        ");
    }
};
