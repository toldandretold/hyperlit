<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Drop startChar and endChar columns from hyperlights and hypercites tables.
     * These columns were legacy backward compatibility fields.
     * The system now exclusively uses the charData column with per-node positions.
     */
    public function up(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn(['startChar', 'endChar']);
        });

        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropColumn(['startChar', 'endChar']);
        });
    }

    /**
     * Reverse the migrations.
     *
     * Restore startChar and endChar columns if migration is rolled back.
     */
    public function down(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->integer('startChar')->nullable();
            $table->integer('endChar')->nullable();
        });

        Schema::table('hypercites', function (Blueprint $table) {
            $table->integer('startChar')->nullable();
            $table->integer('endChar')->nullable();
        });
    }
};
