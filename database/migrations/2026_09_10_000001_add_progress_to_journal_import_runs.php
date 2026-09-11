<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Structured mid-run progress for the import console — what `step_detail` says, in fields.
 *
 * The job already reports every work ("html 7/25: <title>"), but only as prose, so the console
 * could render it as a line of text and nothing else: no bar, no tallies, no failure list until
 * the run ended. This column carries the same beat as data — phase, n/total, the work in hand,
 * running imported/already/failed, and the tail of the failures so far.
 *
 * NOT a key inside `counts`, which is the tempting shortcut. `counts` is written wholesale from
 * `runImportAll()`'s return value when the run finishes, so a mid-run write there is clobbered at
 * the end — and, worse, is READABLE as a final result in the meantime, which is exactly the
 * confusion the column exists to remove. Separate column, separate lifetime: `progress` is the
 * live beat and goes stale the moment the run is terminal, `counts` is the verdict.
 *
 * Nullable with no default: a run that predates this, or one dispatched by a worker still running
 * the old code, reports null and the console falls back to `step_detail`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('journal_import_runs', function (Blueprint $table) {
            $table->jsonb('progress')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('journal_import_runs', function (Blueprint $table) {
            $table->dropColumn('progress');
        });
    }
};
