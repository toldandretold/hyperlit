<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * Download counts — one row = one download = one (subject, format, reader
 * identity, day), the same dedup unit as book_reads / page_views so a
 * "downloads" number sits beside a "views" number and means the same kind of
 * thing (distinct people per day, not raw hits: a re-click, a retry or an
 * HTTP Range resume of the same file the same day is one download; the same
 * book as .md AND .epub is two).
 *
 * `subject_type` says what was downloaded:
 *   - `book`    — subject is the ROOT book id (any format: markdown/docx/epub
 *                 built in the browser and beaconed, m4b/pdf served, the MCP
 *                 markdown export);
 *   - `shelf`   — subject is the shelf uuid (an archive's or journal's vault /
 *                 sqlite export);
 *   - `library` — subject is the username (a user page's whole-library export).
 * Written only by App\Services\Stats\DownloadRecorder; totals read only via
 * App\Services\Stats\StatTotals.
 *
 * Two uniques, not one — Postgres NULLs are distinct, so each identity fork
 * needs its own ON CONFLICT target (the page_views / book_reads pattern).
 *
 * Deliberately NOT RLS'd — same posture as page_views: nobody reads their own
 * rows back, identity is set server-side, and aggregate reads see everyone.
 *
 * `download_rollups` is where rows older than telemetry.raw_retention_days go
 * to forget who they were about (`telemetry:rollup`). No identity columns, BY
 * DESIGN — never add one. Keeping the per-day grain is what lets a graph be
 * drawn later from rollup UNION raw.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('downloads', function ($table) {
            $table->id();
            $table->string('subject_type', 16);
            $table->string('subject');
            $table->string('format', 32);
            $table->string('user_name')->nullable();
            $table->string('anon_token')->nullable();
            $table->date('download_date');
            $table->timestamps();

            $table->unique(['subject_type', 'subject', 'format', 'user_name', 'download_date'], 'downloads_user_unique');
            $table->unique(['subject_type', 'subject', 'format', 'anon_token', 'download_date'], 'downloads_anon_unique');
            $table->index(['subject_type', 'subject']);
        });

        Schema::create('download_rollups', function ($table) {
            $table->string('subject_type', 16);
            $table->string('subject');
            $table->string('format', 32);
            $table->date('download_date');
            $table->integer('downloads');
            $table->primary(['subject_type', 'subject', 'format', 'download_date']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('download_rollups');
        Schema::dropIfExists('downloads');
    }
};
