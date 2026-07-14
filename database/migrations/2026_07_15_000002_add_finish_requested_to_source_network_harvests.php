<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * "Finish harvest now" — the graceful sibling of cancel_requested. Both
     * stop the runner at the next work boundary and both still finalize the
     * shelf + yield report with everything gathered; the difference is intent:
     * finish stamps the run 'completed' (a deliberately shortened harvest),
     * cancel stamps it 'cancelled' (abandoned). See HarvestRunner::$shouldStop.
     */
    public function up(): void
    {
        Schema::table('source_network_harvests', function (Blueprint $table) {
            if (!Schema::hasColumn('source_network_harvests', 'finish_requested')) {
                $table->boolean('finish_requested')->default(false)->after('cancel_requested');
            }
        });
    }

    public function down(): void
    {
        Schema::table('source_network_harvests', function (Blueprint $table) {
            $table->dropColumn('finish_requested');
        });
    }
};
