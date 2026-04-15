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
        Schema::table('library', function (Blueprint $table) {
            $table->jsonb('access_granted')->nullable()->default(null);
        });

        Schema::table('hypercites', function (Blueprint $table) {
            $table->jsonb('access_granted')->nullable()->default(null);
        });

        Schema::table('hyperlights', function (Blueprint $table) {
            $table->jsonb('access_granted')->nullable()->default(null);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn('access_granted');
        });

        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropColumn('access_granted');
        });

        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn('access_granted');
        });
    }
};
