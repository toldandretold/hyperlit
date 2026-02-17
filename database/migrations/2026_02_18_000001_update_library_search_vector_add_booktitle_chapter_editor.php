<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Rebuilds the search_vector generated column to include booktitle, chapter,
     * and editor fields with corrected weights:
     *   A = author, B = title, C = booktitle/chapter, D = editor
     */
    public function up(): void
    {
        DB::statement('DROP INDEX IF EXISTS library_search_vector_idx');

        DB::statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');

        DB::statement("
            ALTER TABLE library ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', COALESCE(author, '')), 'A') ||
                setweight(to_tsvector('simple', COALESCE(title, '')), 'B') ||
                setweight(to_tsvector('simple', COALESCE(booktitle, '')), 'C') ||
                setweight(to_tsvector('simple', COALESCE(chapter, '')), 'C') ||
                setweight(to_tsvector('simple', COALESCE(editor, '')), 'D')
            ) STORED
        ");

        DB::statement('CREATE INDEX library_search_vector_idx ON library USING GIN(search_vector)');
    }

    /**
     * Reverse the migrations.
     *
     * Restores the original search_vector (title = A, author = B only).
     */
    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS library_search_vector_idx');

        DB::statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');

        DB::statement("
            ALTER TABLE library ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', COALESCE(title, '')), 'A') ||
                setweight(to_tsvector('simple', COALESCE(author, '')), 'B')
            ) STORED
        ");

        DB::statement('CREATE INDEX library_search_vector_idx ON library USING GIN(search_vector)');
    }
};
