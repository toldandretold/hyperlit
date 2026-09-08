<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Owner customization of the /u/{username} hero page, stored on the
     * user-home book's library row (book = sanitizedUsername). JSON shape
     * (every key optional, validated by App\Services\UserPageSettingsValidator):
     *
     *   logo_image       book_images filename swapped in for the colon squares
     *   background_image book_images filename behind the lava-lamp hero
     *   css_vars         { "--up-*": validated value } curated variable set
     *   about_html       sanitized HTML for the scrollable about section
     *
     * Lives on `library` (not users.preferences) because VISITORS must read it
     * to render the page. Deliberately NOT included in the regeneration
     * updateOrInsert column lists in UserHomeServerController, so it survives
     * home-book regeneration.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE library
            ADD COLUMN page_settings jsonb NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE library
            DROP COLUMN IF EXISTS page_settings
        ");
    }
};
