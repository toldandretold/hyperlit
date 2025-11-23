<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        // Add node_id column to hyperlights table
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->jsonb('node_id')->nullable()->after('book');
            $table->index('book'); // For efficient queries
        });

        // Add GIN index for array containment queries (PostgreSQL specific)
        DB::statement('CREATE INDEX idx_hyperlights_node_id ON hyperlights USING GIN (node_id)');

        // Add node_id column to hypercites table
        Schema::table('hypercites', function (Blueprint $table) {
            $table->jsonb('node_id')->nullable()->after('book');
            $table->index('book');
        });

        DB::statement('CREATE INDEX idx_hypercites_node_id ON hypercites USING GIN (node_id)');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS idx_hyperlights_node_id');
        DB::statement('DROP INDEX IF EXISTS idx_hypercites_node_id');

        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn('node_id');
        });

        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropColumn('node_id');
        });
    }
};
