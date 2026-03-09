<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Rebuilds the search_vector generated column to include year at weight D:
     *   A = author, B = title, C = booktitle/chapter, D = editor/year
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS library_search_vector_idx');

        DB::connection('pgsql_admin')->statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');

        DB::connection('pgsql_admin')->statement("
            ALTER TABLE library ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', COALESCE(author, '')), 'A') ||
                setweight(to_tsvector('simple', COALESCE(title, '')), 'B') ||
                setweight(to_tsvector('simple', COALESCE(booktitle, '')), 'C') ||
                setweight(to_tsvector('simple', COALESCE(chapter, '')), 'C') ||
                setweight(to_tsvector('simple', COALESCE(editor, '')), 'D') ||
                setweight(to_tsvector('simple', COALESCE(year, '')), 'D')
            ) STORED
        ");

        DB::connection('pgsql_admin')->statement('CREATE INDEX library_search_vector_idx ON library USING GIN(search_vector)');
    }

    /**
     * Reverse: restores search_vector without year.
     */
    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS library_search_vector_idx');

        DB::connection('pgsql_admin')->statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');

        DB::connection('pgsql_admin')->statement("
            ALTER TABLE library ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', COALESCE(author, '')), 'A') ||
                setweight(to_tsvector('simple', COALESCE(title, '')), 'B') ||
                setweight(to_tsvector('simple', COALESCE(booktitle, '')), 'C') ||
                setweight(to_tsvector('simple', COALESCE(chapter, '')), 'C') ||
                setweight(to_tsvector('simple', COALESCE(editor, '')), 'D')
            ) STORED
        ");

        DB::connection('pgsql_admin')->statement('CREATE INDEX library_search_vector_idx ON library USING GIN(search_vector)');
    }
};
