<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * De-identified telemetry rollups — where raw reading-telemetry rows go to
 * forget who they were about.
 *
 * `book_reads` / `page_views` keep one IDENTITY-BEARING row per (book/page,
 * reader, day). The stats they serve only ever need per-book/page daily
 * COUNTS once the recent window has passed, so `telemetry:rollup` folds rows
 * older than config('telemetry.raw_retention_days') into these tables and
 * deletes the raw rows — the APP 11 "destroy or de-identify when no longer
 * needed" obligation made mechanical, and what lets the privacy page promise
 * a retention horizon for identity-linked telemetry.
 *
 * One row = one (book/page, day) with the summed view count. No identity
 * columns, BY DESIGN — never add one. Dedup already happened when the raw
 * rows were written (ON CONFLICT per identity per day), so these sums stay
 * exactly as honest as the rows they replace.
 *
 * Written/read on pgsql_admin only (the sweep command + the stats readers).
 * No RLS: nothing here is anyone's personal data — that is the point.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('book_read_rollups', function ($table) {
            $table->string('book');
            $table->date('read_date');
            $table->integer('views');
            $table->primary(['book', 'read_date']);
        });

        Schema::create('page_view_rollups', function ($table) {
            $table->string('page');
            $table->date('view_date');
            $table->integer('views');
            $table->primary(['page', 'view_date']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('book_read_rollups');
        Schema::dropIfExists('page_view_rollups');
    }
};
