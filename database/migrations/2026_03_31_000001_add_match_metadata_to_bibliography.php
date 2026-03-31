<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     * Adds match_method and match_score columns to persist how each
     * bibliography entry was resolved and how confident the match was.
     */
    public function up(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->string('match_method', 50)->nullable()->after('llm_metadata');
            $table->float('match_score')->nullable()->after('match_method');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->dropColumn(['match_method', 'match_score']);
        });
    }
};
