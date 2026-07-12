<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Harvest billing cap + cancellation — two per-run fields alongside the
 * existing max_depth / max_works config on the row:
 *  - max_spend: the user's optional hard spend ceiling for the run (null = no
 *    cap, balance is the only limit). Set on the approve form, read by the
 *    worker. The run's actual spend is derivable from billing_ledger, so it is
 *    NOT stored here — the runner tracks it in-process for the cap check and
 *    stamps the final total into counts.
 *  - cancel_requested: a poll flag the cancel button sets and the runner checks
 *    at each work boundary (status stays owned by the job, so no race).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('source_network_harvests', function (Blueprint $table) {
            $table->decimal('max_spend', 10, 2)->nullable();
            $table->boolean('cancel_requested')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('source_network_harvests', function (Blueprint $table) {
            $table->dropColumn(['max_spend', 'cancel_requested']);
        });
    }
};
