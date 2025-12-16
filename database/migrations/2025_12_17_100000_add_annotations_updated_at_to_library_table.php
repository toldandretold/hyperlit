<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Adds a separate timestamp for tracking annotation changes (highlights/hypercites).
     * This separates content changes (nodes) from annotation changes, fixing a security
     * issue where non-owners could manipulate library.timestamp via highlight additions.
     */
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->bigInteger('annotations_updated_at')->default(0)->after('timestamp');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn('annotations_updated_at');
        });
    }
};
