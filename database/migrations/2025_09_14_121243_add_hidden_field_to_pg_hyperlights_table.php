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
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->boolean('hidden')->default(false)->after('creator_token');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn('hidden');
        });
    }
};
