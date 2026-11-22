<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Storage for the conversion lint shown on /maintainer/journal-import (App\Services\Conversion\
 * ConversionLint — "search a journal for problems").
 *
 * `conversion_lint_results` is a per-book CACHE of the lint, keyed by the book's content clock:
 * a row is valid only while `library_timestamp` equals `library.timestamp`, which every reconvert
 * bumps. It exists so the console can rank a 960-article journal with one query instead of
 * re-reading every node on each page load. `chrome` holds the book's page-furniture CANDIDATES
 * (string => occurrences); whether one is a leak is only decidable across the whole journal, so
 * that verdict is computed at read time and never stored here.
 *
 * `conversion_lint_snapshots` is the "before" half of a before/after comparison around a corpus
 * reconvert: one row per journal, holding every book's finding KEYS (detector + excerpt hash —
 * node ids change on reconvert, the excerpt does not) and the content clock they were taken at,
 * so the comparison can tell "reconverted and now clean" from "not reconverted yet".
 *
 * Operator-only, like journal_import_runs: read and written through pgsql_admin, no RLS.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('conversion_lint_results', function (Blueprint $table) {
            $table->string('book')->primary();
            $table->bigInteger('library_timestamp');           // library.timestamp the lint was computed at
            $table->unsignedSmallInteger('lint_version');      // ConversionLint::VERSION — a detector change invalidates
            $table->unsignedInteger('score')->default(0);      // without chrome leaks (those are journal-relative)
            $table->jsonb('findings')->default('[]');
            $table->jsonb('chrome')->default('{}');
            $table->timestamp('computed_at')->nullable();
        });

        Schema::create('conversion_lint_snapshots', function (Blueprint $table) {
            $table->uuid('journal_source_id')->primary();
            $table->string('taken_by')->nullable();
            $table->timestamp('taken_at');
            $table->jsonb('books');                            // book => {timestamp, counts, keys}
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conversion_lint_snapshots');
        Schema::dropIfExists('conversion_lint_results');
    }
};
