<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Detected book language (BookLanguageDetector) — DELIBERATELY a separate
     * column from `library.language`, which is a DECLARED bibliographic value
     * (import metadata / the owner's form) and the only thing allowed to feed
     * citation_language and JSON-LD inLanguage (claims about the work — see the
     * comments in TextController::buildSeoData). The detected value feeds
     * `<html lang>` ONLY, as a fallback when nothing is declared.
     *
     * `language_detected_at` is stamped even when detection returns NULL
     * (confidently unknown), so the weekly --stale sweep doesn't retry the same
     * undetectable book forever; staleness = library.timestamp newer than this.
     *
     * Nullable, no default: NULL = "never attempted". Never accepted from a
     * client payload, and — like page_settings — deliberately NOT in any
     * regeneration/updateOrInsert column list, so it survives reconversion.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('
            ALTER TABLE library
            ADD COLUMN language_detected varchar(16) NULL,
            ADD COLUMN language_detected_at timestamptz NULL
        ');
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('
            ALTER TABLE library
            DROP COLUMN IF EXISTS language_detected,
            DROP COLUMN IF EXISTS language_detected_at
        ');
    }
};
