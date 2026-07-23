<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * citation_pipelines.failure_notified_at — idempotency latch for the pipeline
 * failure notifier (apology email to the user + bug report to the maintainer).
 * Set atomically when the notifier claims a failure; a run notifies at most
 * once no matter how many pollers/retries observe the failed state.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement(
            'ALTER TABLE citation_pipelines ADD COLUMN failure_notified_at timestamp'
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement(
            'ALTER TABLE citation_pipelines DROP COLUMN IF EXISTS failure_notified_at'
        );
    }
};
