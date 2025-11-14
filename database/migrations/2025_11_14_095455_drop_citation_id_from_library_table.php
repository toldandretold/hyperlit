<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Drop the redundant citationID column - book column is the primary key
     * and serves the same purpose. This eliminates data duplication and
     * inconsistent usage across the codebase.
     */
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn('citationID');
        });
    }

    /**
     * Reverse the migrations.
     *
     * Restore citationID column and copy data from book column
     */
    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->string('citationID', 255)->nullable()->after('bibtex');
        });

        // Copy book values to citationID for rollback
        DB::statement('UPDATE library SET "citationID" = book WHERE "citationID" IS NULL');
    }
};
