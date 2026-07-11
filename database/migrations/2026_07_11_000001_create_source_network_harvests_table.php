<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * State for Source Network Harvester runs: from a root book, scan its
 * bibliography (citation:scan-bibliography), then fetch + convert every
 * eligible open-access canonical into an auto_version_book. The frontier
 * queue + max_depth make the design recursion-ready (harvesting the
 * harvested texts' own citations) without a schema change.
 *
 * Deliberately its own table, NOT citation_pipelines: the pipeline's
 * PipelineMap/PipelineMapDriftTest contract hard-codes its four-stage chain,
 * and a harvest has a different lifecycle (frontier, depth, work budget).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('source_network_harvests', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('root_book')->index();
            $table->unsignedBigInteger('user_id')->nullable();
            $table->string('status', 20)->default('pending');   // pending, running, completed, failed
            $table->unsignedSmallInteger('max_depth')->default(1);
            $table->unsignedInteger('max_works');                // per-run hard cap, snapshotted at trigger time
            $table->jsonb('frontier')->default('[]');            // queue of {book, depth} not yet scanned
            $table->jsonb('visited_books')->default('[]');       // cycle guard for future depth>1 runs
            $table->string('step', 30)->nullable();              // scan, harvest
            $table->text('step_detail')->nullable();             // e.g. "Importing work 3/42"
            $table->jsonb('counts')->default('{}');              // eligible/attempted/assigned/... tallies
            $table->jsonb('telemetry')->default('[]');           // capped event stream (see HarvestTelemetry)
            $table->text('error')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('source_network_harvests');
    }
};
