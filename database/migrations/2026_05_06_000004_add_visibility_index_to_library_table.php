<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Add a partial index on library(book) covering only public-listed rows.
     * The full-text node search drives from library when terms are common,
     * and previously fell back to a Parallel Seq Scan filtering listed=true
     * across ~300k rows. Only ~900 are listed=true, so the partial index
     * is tiny and lets the planner avoid the seq scan.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            CREATE INDEX IF NOT EXISTS library_listed_visible_idx
            ON library (book)
            WHERE listed = true AND visibility NOT IN ('private', 'deleted')
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS library_listed_visible_idx');
    }
};
