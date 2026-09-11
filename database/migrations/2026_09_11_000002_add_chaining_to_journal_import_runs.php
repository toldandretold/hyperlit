<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Let a bulk import continue itself until the journal is done.
 *
 * A run is capped at 50 minutes (`JournalImportActionJob::WORK_BUDGET`), and that cap is not
 * negotiable: `timeout` must stay under the database queue's `retry_after` or a still-running job
 * is picked up a second time and two workers write the same books. The consequence is that a
 * journal of any size needs many runs — tripleC's 960 works, at the ~41s/work its publisher
 * affords, is about a dozen — and every one of them was a manual press.
 *
 * So the loop moves into the job: when a run stops at the budget with work left, it enqueues its
 * own successor. Three columns make that safe rather than a runaway:
 *
 *   - `continue_until_done` — opt-in per run. Never a default, because the successor spends money
 *     with nobody watching.
 *   - `spend_cap` — the ceiling for the WHOLE chain, in dollars. Checked before enqueuing the next
 *     link, so the chain stops short rather than discovering the overrun afterwards.
 *   - `chain_spend` — what the chain has spent so far, carried forward link to link. Each run row
 *     records only its own spend in `counts`; without an accumulator the cap would be re-evaluated
 *     against a single run's total and never trip.
 *
 * `chain_position` is for the operator, not the logic: "run 7 of a chain" is the difference between
 * a console that looks stuck and one that is visibly making progress.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('journal_import_runs', function (Blueprint $table) {
            $table->boolean('continue_until_done')->default(false);
            $table->decimal('spend_cap', 10, 4)->nullable();
            $table->decimal('chain_spend', 10, 4)->default(0);
            $table->integer('chain_position')->default(1);
        });
    }

    public function down(): void
    {
        Schema::table('journal_import_runs', function (Blueprint $table) {
            $table->dropColumn(['continue_until_done', 'spend_cap', 'chain_spend', 'chain_position']);
        });
    }
};
