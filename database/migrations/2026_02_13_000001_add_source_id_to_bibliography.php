<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     * Adds source_id column to bibliography table for linked citations.
     * - null for unlinked citations (imported from EPUB)
     * - book ID for internal citations (linking to Hyperlit books)
     * - OpenAlex work ID for external citations (future)
     */
    public function up(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->string('source_id')->nullable()->after('referenceId');
            $table->index('source_id');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->dropIndex(['source_id']);
            $table->dropColumn('source_id');
        });
    }
};
