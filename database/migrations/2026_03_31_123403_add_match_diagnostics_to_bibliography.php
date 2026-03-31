<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->json('match_diagnostics')->nullable()->after('match_score');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->dropColumn('match_diagnostics');
        });
    }
};
