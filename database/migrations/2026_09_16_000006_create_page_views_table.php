<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * Page views for the non-reader surfaces (home first) — one row = one view =
 * one (page, reader identity, day), the SAME dedup semantics as book_reads so
 * the two numbers mean the same thing when shown side by side on
 * /maintainer/stats.
 *
 * A SEPARATE table rather than a sentinel row in book_reads: that table is
 * keyed on a real `book` and joined to `library` all over the stats code
 * (top-books, depth, per-creator rollups). A fake book id for the homepage
 * would need excluding from every one of those call sites, and the one already
 * there (`WHERE r.book <> 'stats'`) shows how that goes — it's a landmine, not
 * a pattern. A page has no chunks, no depth and no creator, so it has no
 * business in a table whose every other column is about a book.
 *
 * `page` is a free varchar, not an enum: 'home' is the only value the client
 * sends today, but user/journal feed pages are the obvious next ones and they
 * shouldn't need a migration. The controller whitelists what it accepts.
 *
 * Deliberately NOT RLS'd — same posture (and same reasoning) as book_reads:
 * readers never read it back, the identity columns are set server-side, and
 * aggregate reads must see everyone's rows anyway.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('page_views', function ($table) {
            $table->id();
            $table->string('page');                     // 'home' (whitelisted server-side)
            $table->string('user_name')->nullable();
            $table->string('anon_token')->nullable();
            $table->date('view_date');
            $table->timestamps();

            // One row per identity per day, per page. Two uniques, not one:
            // Postgres treats NULLs as distinct, so a single composite over
            // both identity columns would let the null side duplicate freely —
            // the same fork book_reads makes, and the reason the controller
            // needs a per-branch ON CONFLICT target.
            $table->unique(['page', 'user_name', 'view_date']);
            $table->unique(['page', 'anon_token', 'view_date']);
            $table->index(['page', 'view_date']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('page_views');
    }
};
