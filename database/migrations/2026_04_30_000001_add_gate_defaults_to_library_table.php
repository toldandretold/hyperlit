<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->jsonb('gate_defaults')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn('gate_defaults');
        });
    }
};
