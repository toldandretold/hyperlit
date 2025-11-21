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
        // Add charData column to hyperlights (keep existing node_id column)
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->jsonb('charData')->default('{}')->after('node_id');
        });

        // Add charData column to hypercites (keep existing node_id column)
        Schema::table('hypercites', function (Blueprint $table) {
            $table->jsonb('charData')->default('{}')->after('node_id');
        });

        // Create GIN indexes for efficient charData queries
        DB::statement('CREATE INDEX idx_hyperlights_chardata ON hyperlights USING GIN ("charData")');
        DB::statement('CREATE INDEX idx_hypercites_chardata ON hypercites USING GIN ("charData")');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        // Drop indexes
        DB::statement('DROP INDEX IF EXISTS idx_hyperlights_chardata');
        DB::statement('DROP INDEX IF EXISTS idx_hypercites_chardata');

        // Drop charData columns
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn('charData');
        });

        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropColumn('charData');
        });
    }
};
