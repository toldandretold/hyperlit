<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->integer('recent')->nullable();
            $table->integer('total_views')->nullable();
            $table->integer('total_citations')->nullable();
            $table->integer('total_highlights')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn([
                'recent',
                'total_views',
                'total_citations',
                'total_highlights',
            ]);
        });
    }
};
