<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Structured mid-run progress for the hypercite console's detect run — what `step_detail` says,
 * in fields. Same column, same lifetime and same reasoning as `journal_import_runs.progress`
 * (2026_09_10_000001): that console proved that a prose line is not enough for a run measured in
 * hours, and this one is the longer of the two — a first pass over a journal runs a bibliography
 * scan (LLM + external lookups, minutes per article) for every book, and the console reported it
 * as a single sentence with no denominator.
 *
 * NOT a key inside `counts`. `counts` here is BOTH written per book by CandidateDetector::step()
 * and overwritten wholesale with the run's verdict when the job finishes, so mid-run it reads as
 * a result that is not one. Separate column, separate lifetime: `progress` is the live beat (and
 * goes stale the moment the run is terminal), `counts` is the verdict.
 *
 * Nullable with no default: a run dispatched before this shipped — or one still being worked by a
 * pre-deploy worker — reports null, and the console falls back to `step_detail`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hypercite_runs', function (Blueprint $table) {
            $table->jsonb('progress')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('hypercite_runs', function (Blueprint $table) {
            $table->dropColumn('progress');
        });
    }
};
