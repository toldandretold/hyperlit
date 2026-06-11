<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Live telemetry for the citation pipeline: an append-only JSONB event list
 * ({stage, substage, status, detail, signals, at}) written by
 * App\Services\CitationPipeline\PipelineTelemetry and read by the
 * pipeline-status endpoint for the in-page live visualisation.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('citation_pipelines', function (Blueprint $table) {
            $table->jsonb('telemetry')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('citation_pipelines', function (Blueprint $table) {
            $table->dropColumn('telemetry');
        });
    }
};
