<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Owner-minted archives (a user's own public shelf at /a/{slug}, see
 * ShelfArchiveMinter) carry NO name or about copy of their own: NULL means
 * "use the shelf's live name / description" (ArchiveIdentity), so renaming
 * the shelf renames the archive page with no sync code. Maintainer-made
 * archives keep their explicit values.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement(
            'ALTER TABLE archive_sources ALTER COLUMN display_name DROP NOT NULL'
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement(
            "UPDATE archive_sources a SET display_name = COALESCE(s.name, a.slug)
               FROM (SELECT id, name FROM shelves) s
              WHERE a.display_name IS NULL AND s.id = a.shelf_id"
        );
        DB::connection('pgsql_admin')->statement(
            'UPDATE archive_sources SET display_name = slug WHERE display_name IS NULL'
        );
        DB::connection('pgsql_admin')->statement(
            'ALTER TABLE archive_sources ALTER COLUMN display_name SET NOT NULL'
        );
    }
};
