<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Drop hyperlights and hypercites columns from nodes table.
     * These columns stored embedded JSON arrays in the OLD system.
     * After migration to normalized schema, these are no longer needed.
     */
    public function up(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropColumn(['hyperlights', 'hypercites']);
        });
    }

    /**
     * Reverse the migrations.
     *
     * Restore hyperlights and hypercites columns if migration is rolled back.
     */
    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->jsonb('hyperlights')->nullable();
            $table->jsonb('hypercites')->nullable();
        });
    }
};
