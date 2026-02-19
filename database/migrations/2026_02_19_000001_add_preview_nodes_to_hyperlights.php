<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            // Stores first 1-2 rendered node objects for quick display without fetching
            // the full sub-book. Replaces annotation varchar(1000) for new records.
            // Keep existing annotation column for backward-compat (legacy read path).
            $table->jsonb('preview_nodes')->nullable()->after('annotation');
        });
    }

    public function down(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn('preview_nodes');
        });
    }
};
