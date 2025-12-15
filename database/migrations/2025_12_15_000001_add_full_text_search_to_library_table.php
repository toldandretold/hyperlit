<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Adds PostgreSQL full-text search capability to the library table.
     * Creates a generated tsvector column combining title (weight A) and author (weight B)
     * with a GIN index for fast searching.
     */
    public function up(): void
    {
        // Add tsvector column for full-text search on title + author
        // Using GENERATED ALWAYS AS STORED so it auto-updates when title/author change
        DB::statement("
            ALTER TABLE library
            ADD COLUMN IF NOT EXISTS search_vector tsvector
            GENERATED ALWAYS AS (
                setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
                setweight(to_tsvector('english', COALESCE(author, '')), 'B')
            ) STORED
        ");

        // Create GIN index for fast full-text search
        DB::statement("
            CREATE INDEX IF NOT EXISTS library_search_vector_idx
            ON library USING GIN(search_vector)
        ");
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS library_search_vector_idx');
        DB::statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');
    }
};
