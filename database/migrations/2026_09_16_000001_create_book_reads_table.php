<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Reading analytics: one row = one "view" = one (book, reader identity, day).
 *
 * Deliberately NOT RLS'd — same posture as user_reading_positions: readers never
 * read this table back (creators only ever see aggregates via controllers), the
 * identity columns are set server-side by ReadingTelemetryController's identity
 * fork, and aggregate reads must see everyone's rows anyway.
 *
 * chunks_viewed is jsonb (not int[]) because chunk ids can be FRACTIONAL
 * (fractional indexing when a chunk splits; parseChunkId = parseFloat client-side).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('book_reads', function ($table) {
            $table->id();
            $table->string('book');            // ALWAYS the root book id — sub-books rolled up
            $table->string('user_name')->nullable();
            $table->string('anon_token')->nullable();
            $table->date('read_date');
            $table->jsonb('chunks_viewed')->default('[]');
            $table->double('max_chunk')->nullable();
            $table->integer('total_chunks')->nullable();
            $table->timestamps();

            // The two ON CONFLICT targets — Postgres treats NULLs as distinct, so
            // each identity branch upserts against its own unique index.
            $table->unique(['book', 'user_name', 'read_date']);
            $table->unique(['book', 'anon_token', 'read_date']);
            $table->index(['book', 'read_date']);
        });

        // The old total_views values were client-seeded junk (the column had no
        // server-side writer; DbLibraryController took it straight from the sync
        // payload). ReadStatsCounter is now the sole writer — reset to NULL
        // ("never computed", same convention as the connection-count columns).
        DB::connection('pgsql_admin')->update('UPDATE library SET total_views = NULL WHERE total_views IS NOT NULL');
    }

    public function down(): void
    {
        Schema::dropIfExists('book_reads');
    }
};
