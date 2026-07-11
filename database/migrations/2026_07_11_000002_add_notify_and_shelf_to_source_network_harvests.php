<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Harvest UX additions: an opt-in "email me when done" flag (set via
 * POST /api/source-harvest/{id}/notify, consumed by SourceNetworkHarvestJob
 * on completion/failure) and a pointer to the "Harvested from: <Title>"
 * shelf the run collects its sources onto (created by HarvestShelf).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('source_network_harvests', function (Blueprint $table) {
            $table->boolean('notify_email')->default(false);
            $table->uuid('shelf_id')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('source_network_harvests', function (Blueprint $table) {
            $table->dropColumn(['notify_email', 'shelf_id']);
        });
    }
};
