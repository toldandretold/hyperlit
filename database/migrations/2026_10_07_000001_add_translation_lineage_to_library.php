<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Translation lineage as REAL columns — `translated_from` (the source
     * book id) and `translation_target` (the BCP 47 target, e.g. 'en',
     * 'zh-Hans') — written only by BookTranslationService::writeCopy.
     *
     * Why not raw_json, where the feature first put them: raw_json is
     * wholesale-REBUILT on every metadata save (the client reconstructs it
     * from top-level fields in indexedDB/core/library.ts, the server
     * overwrites it in DbLibraryController::upsert), so lineage stored there
     * dies the first time the copy's owner edits its title. It is also
     * unindexed, and the global "does any visible translation of this book
     * exist" dedupe is a hot read.
     *
     * Nullable, no default: NULL = "not a translation". Never accepted from
     * a client payload (not in $fillable, not in LibraryUpsertRequest), and —
     * like language_detected — deliberately NOT in any regeneration column
     * list, so it survives reconversion. The raw_json mirror keys stay for
     * display, but every QUERY uses these columns.
     *
     * The composite index serves the dedupe lookup (translated_from +
     * translation_target) and, on its leading column, the versions rail's
     * "all translations of this book" family query.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('
            ALTER TABLE library
            ADD COLUMN translated_from varchar(255) NULL,
            ADD COLUMN translation_target varchar(10) NULL
        ');
        DB::connection('pgsql_admin')->statement('
            CREATE INDEX library_translated_from_target_idx
            ON library (translated_from, translation_target)
            WHERE translated_from IS NOT NULL
        ');

        // Backfill copies minted before the columns existed (lineage was in
        // raw_json only). translation_target falls back to the copy's own
        // language column, which writeCopy has always set to the target.
        DB::connection('pgsql_admin')->statement("
            UPDATE library
            SET translated_from = raw_json->>'translated_from',
                translation_target = COALESCE(raw_json->>'translation_target', language)
            WHERE raw_json->>'translated_from' IS NOT NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('
            DROP INDEX IF EXISTS library_translated_from_target_idx
        ');
        DB::connection('pgsql_admin')->statement('
            ALTER TABLE library
            DROP COLUMN IF EXISTS translated_from,
            DROP COLUMN IF EXISTS translation_target
        ');
    }
};
