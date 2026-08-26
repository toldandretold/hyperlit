<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Let a journal_import_runs row be scoped to a SHELF instead of a journal — the
 * /maintainer/shelf-import console fires the same article actions (import,
 * reconvert_html, refetch_html) over a shelf's canonicals, dispatching the same
 * JournalImportActionJob. Mirrors hypercite_runs' convention: exactly one of
 * journal_source_id / shelf_id is set per row.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE journal_import_runs ALTER COLUMN journal_source_id DROP NOT NULL');

        Schema::table('journal_import_runs', function (Blueprint $table) {
            $table->uuid('shelf_id')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::table('journal_import_runs', function (Blueprint $table) {
            $table->dropColumn('shelf_id');
        });

        DB::statement('ALTER TABLE journal_import_runs ALTER COLUMN journal_source_id SET NOT NULL');
    }
};
