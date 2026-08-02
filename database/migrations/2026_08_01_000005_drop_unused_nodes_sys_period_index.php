<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Drop the GIST index on live nodes' sys_period (65 MB in prod,
     * 0 lifetime scans per pg_stat_user_indexes). On the LIVE table
     * sys_period is always [last_edit, ∞) — point-in-time queries go to
     * nodes_history, which has its own GIST index
     * (nodes_history_sys_period_idx, untouched). No app code filters on
     * nodes.sys_period; NodeHistoryController queries the history table.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS nodes_sys_period_idx');
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('CREATE INDEX IF NOT EXISTS nodes_sys_period_idx ON nodes USING GIST (sys_period)');
    }
};
