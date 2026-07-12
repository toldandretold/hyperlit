<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Source Yield Report: keep the per-work outcomes (not just aggregate counts)
 * so the harvest can write a readable report of what it could and couldn't
 * pull, and remember the report book it wrote.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('source_network_harvests', function (Blueprint $table) {
            $table->jsonb('results')->default('[]');  // per-work: canonical meta + status/reason/via/book
            $table->string('report_book')->nullable(); // the Source Yield Report library book id
        });
    }

    public function down(): void
    {
        Schema::table('source_network_harvests', function (Blueprint $table) {
            $table->dropColumn(['results', 'report_book']);
        });
    }
};
