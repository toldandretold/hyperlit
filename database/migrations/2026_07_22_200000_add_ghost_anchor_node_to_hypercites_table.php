<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Ghost anchor for hypercites, mirroring hyperlights.ghost_anchor_node
 * (migration 2026_07_22_180000): the nearest surviving PRECEDING node's
 * data-node-id, captured when a cite's only node is deleted (client batch.ts
 * tombstone flow — which also flips relationshipStatus to 'ghost' instead of
 * destroying the record). Maintained server-side by
 * CharDataRecalculator::reanchorForDeletedNodes.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->string('ghost_anchor_node')->nullable()->after('hyperciteId');
        });
    }

    public function down(): void
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropColumn('ghost_anchor_node');
        });
    }
};
