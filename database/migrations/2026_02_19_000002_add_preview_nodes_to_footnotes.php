<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('footnotes', function (Blueprint $table) {
            // Stores first 1-2 rendered node objects for quick display without fetching
            // the full sub-book. The existing content (text) column served this role
            // as a flat HTML string; preview_nodes stores structured node objects.
            // Keep existing content column for backward-compat (legacy read path).
            $table->jsonb('preview_nodes')->nullable()->after('content');
        });
    }

    public function down(): void
    {
        Schema::table('footnotes', function (Blueprint $table) {
            $table->dropColumn('preview_nodes');
        });
    }
};
