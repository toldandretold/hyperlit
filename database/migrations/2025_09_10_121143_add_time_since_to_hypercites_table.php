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
        Schema::table('hypercites', function (Blueprint $table) {
            $table->bigInteger('time_since')->nullable()->after('raw_json');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropColumn('time_since');
        });
    }
};
