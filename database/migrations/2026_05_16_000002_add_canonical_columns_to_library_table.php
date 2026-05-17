<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            // Null = not yet associated with a canonical source. When set, this row is recognised
            // as a version of that canonical citation identity.
            $table->uuid('canonical_source_id')->nullable();

            // How this version was produced: pdf_ocr / epub_import / docx / html / markdown /
            // manual / openalex_stub. Null on legacy rows.
            $table->string('conversion_method', 50)->nullable();

            // Null = ingested with no human oversight (e.g. backend PDF pipeline). Set when a
            // logged-in user opens the editor and saves.
            $table->timestamp('human_reviewed_at')->nullable();

            // True only when uploader's verified identity matches the canonical's publisher/author.
            $table->boolean('is_publisher_uploaded')->default(false);

            // Reserved. Scoring algorithm ships later.
            $table->decimal('credibility_score', 5, 2)->nullable();
        });

        Schema::table('library', function (Blueprint $table) {
            $table->index('canonical_source_id');
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropIndex(['canonical_source_id']);
            $table->dropColumn([
                'canonical_source_id',
                'conversion_method',
                'human_reviewed_at',
                'is_publisher_uploaded',
                'credibility_score',
            ]);
        });
    }
};
