<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // OpenAlex biblio page range for the work, used by the harvester's
        // partial-PDF gate: a downloaded PDF far shorter than (last_page-first_page)
        // is almost certainly a table of contents / intro chapter, not the source
        // text, and must NOT be imported as the source. WorkNormaliser already
        // extracts these (biblio.first_page / biblio.last_page); this persists them
        // so the fetch ladder can compare without re-hitting OpenAlex.
        // See app/Services/ContentFetchService.php (validatePdfExtent).
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
                ADD COLUMN first_page integer NULL,
                ADD COLUMN last_page integer NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
                DROP COLUMN IF EXISTS first_page,
                DROP COLUMN IF EXISTS last_page
        ");
    }
};
