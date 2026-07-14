<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Content-completeness of THIS version of a work — a per-version property, so
     * it lives on the library row (a harvested `auto` version can be a `partial`
     * chapter while a future `commons` upload is `verified_full`).
     *
     *   verified_full — content matches the work's known extent (full text).
     *   partial       — real but incomplete: a chapter / front-matter / bronze-book
     *                    teaser. KEPT (still useful) but flagged so citation review
     *                    never mistakes it for the whole work.
     *   unverified    — couldn't judge fullness (no page range, HTML lane, etc).
     *   null          — not applicable (ordinary user uploads).
     *
     * See app/Services/ContentFetchService.php (assessCompleteness) and
     * app/Services/CanonicalVersions/AutoVersionCreator.php (applyCompleteness).
     */
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->string('completeness', 20)->nullable()->after('work_license');
            $table->text('completeness_reason')->nullable()->after('completeness');
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn(['completeness', 'completeness_reason']);
        });
    }
};
