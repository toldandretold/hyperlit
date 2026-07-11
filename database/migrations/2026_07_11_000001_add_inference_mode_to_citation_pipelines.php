<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * citation_pipelines.inference_mode — 'server' (default; shared key, billed) or
 * 'client' (BYO: the user's native app executes the LLM calls via inference
 * tickets; only server-side OCR costs are billed). Lives on the pipeline row so
 * resume/retry flows recover the mode without the client restating it.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement(
            "ALTER TABLE citation_pipelines ADD COLUMN inference_mode varchar(10) NOT NULL DEFAULT 'server'"
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement(
            'ALTER TABLE citation_pipelines DROP COLUMN IF EXISTS inference_mode'
        );
    }
};
