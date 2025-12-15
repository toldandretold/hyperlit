<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Adds PostgreSQL full-text search capability to the nodes table.
     * Creates a generated tsvector column using COALESCE(plainText, content)
     * so nodes with NULL plainText still get indexed (using HTML content as fallback).
     * GIN index for fast searching.
     */
    public function up(): void
    {
        // Add tsvector column for full-text search on plainText (with content fallback)
        // Using GENERATED ALWAYS AS STORED so it auto-updates when plainText/content change
        DB::statement("
            ALTER TABLE nodes
            ADD COLUMN IF NOT EXISTS search_vector tsvector
            GENERATED ALWAYS AS (
                to_tsvector('english', COALESCE(\"plainText\", content, ''))
            ) STORED
        ");

        // Create GIN index for fast full-text search
        DB::statement("
            CREATE INDEX IF NOT EXISTS nodes_search_vector_idx
            ON nodes USING GIN(search_vector)
        ");
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS nodes_search_vector_idx');
        DB::statement('ALTER TABLE nodes DROP COLUMN IF EXISTS search_vector');
    }
};
