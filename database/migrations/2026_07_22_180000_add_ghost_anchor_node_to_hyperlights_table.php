<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Ghost anchor for whole-node-deletion ghosts: the nearest surviving PRECEDING
 * node's data-node-id, captured when a highlight's only node is deleted
 * (client batch.ts tombstone flow). node_ids survive renumbering, so ghost
 * position/navigation derive from this instead of the frozen startLine.
 * Maintained server-side by CharDataRecalculator::reanchorForDeletedNodes when
 * an anchor node is itself deleted (the chain walks up the book, never dangles).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->string('ghost_anchor_node')->nullable()->after('sub_book_id');
        });
    }

    public function down(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn('ghost_anchor_node');
        });
    }
};
