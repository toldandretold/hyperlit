<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     * Adds llm_metadata jsonb column to cache LLM-extracted citation metadata
     * (title, authors, year, journal, publisher, doi) so re-scans skip the LLM.
     */
    public function up(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->jsonb('llm_metadata')->nullable()->after('foundation_source');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->dropColumn('llm_metadata');
        });
    }
};
