<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The bad-conversion queue — one row per "this book's conversion is
     * suspect" signal, feeding `library:reconvert-queue`. Sources: a reader's
     * "report an issue" (conversionFeedback rating=bad), the automated
     * garbage sweep (`library:flag-sweep`), or a manual flag. Deliberately a
     * separate table (not columns on `library`): a book accumulates flag
     * HISTORY, and the table carries no RLS policy so both the HTTP context
     * and console commands write it on the default connection.
     *
     * The partial unique index means repeat reports of the same kind UPSERT
     * into the one open flag (details.report_count bumps) instead of piling
     * up duplicates; resolving a flag frees the slot for a future regression.
     */
    public function up(): void
    {
        Schema::create('conversion_flags', function (Blueprint $table) {
            $table->id();
            $table->string('book')->index();
            $table->string('source', 32); // user_report | auto_sweep | manual
            $table->text('reason')->nullable();
            $table->jsonb('details')->default('{}'); // issueTypes, sweep signals, report_count…
            $table->string('status', 16)->default('open'); // open | resolved | dismissed
            $table->string('resolution', 32)->nullable(); // reconverted | refetched | dismissed
            $table->timestampTz('resolved_at')->nullable();
            $table->timestampsTz();
        });

        // One OPEN flag per (book, source); history rows keep status resolved/dismissed.
        DB::statement(
            'CREATE UNIQUE INDEX conversion_flags_open_unique
             ON conversion_flags (book, source) WHERE status = \'open\''
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('conversion_flags');
    }
};
