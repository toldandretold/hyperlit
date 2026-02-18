<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            // Does this entry have book content in the nodes table?
            // All existing records default to true (they do have content).
            $table->boolean('has_nodes')->default(true)->after('listed');

            // OpenAlex work ID (e.g. "W2142043891"). Non-null = sourced/verified from OpenAlex.
            $table->string('openalex_id', 30)->nullable()->after('has_nodes');

            // Dedicated DOI field (currently only buried in bibtex text or url)
            $table->string('doi', 255)->nullable()->after('openalex_id');

            // Open access metadata from OpenAlex
            $table->boolean('is_oa')->nullable()->after('doi');
            $table->string('oa_status', 20)->nullable()->after('is_oa');
            $table->text('oa_url')->nullable()->after('oa_status');
            $table->text('pdf_url')->nullable()->after('oa_url');

            // The work's own content license (distinct from platform license column)
            $table->string('work_license', 100)->nullable()->after('pdf_url');

            // Citation count from OpenAlex
            $table->integer('cited_by_count')->nullable()->after('work_license');

            // ISO 639-1 language code
            $table->string('language', 10)->nullable()->after('cited_by_count');
        });

        // Fast duplicate-prevention lookup
        Schema::table('library', function (Blueprint $table) {
            $table->index('openalex_id');
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropIndex(['openalex_id']);
            $table->dropColumn([
                'has_nodes',
                'openalex_id',
                'doi',
                'is_oa',
                'oa_status',
                'oa_url',
                'pdf_url',
                'work_license',
                'cited_by_count',
                'language',
            ]);
        });
    }
};
