<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * shelves.overview_book — the ONE member book the owner nominates as the
     * shelf's overview (a course intro, a reading-list readme): pinned first
     * in every render with a visible pin, shown as the archive page's about,
     * and exported as the vault's hub note. NULL = none. No FK (the codebase's
     * convention) — App\Services\Shelves\ShelfOverview only honours a value
     * that is still a member of the shelf, so a stale id is inert.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('ALTER TABLE shelves ADD COLUMN IF NOT EXISTS overview_book varchar NULL');
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('ALTER TABLE shelves DROP COLUMN IF EXISTS overview_book');
    }
};
