<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Cap for the scope-wide `import_cited_bulk` action — "import the next N of the
 * most-cited external OA works". Same column and semantics as
 * journal_import_runs.work_limit: 0 means "everything listed" (the most-cited
 * query is itself capped at 150), a deliberate choice behind a confirm, never
 * the default.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hypercite_runs', function (Blueprint $table) {
            $table->integer('work_limit')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('hypercite_runs', function (Blueprint $table) {
            $table->dropColumn('work_limit');
        });
    }
};
