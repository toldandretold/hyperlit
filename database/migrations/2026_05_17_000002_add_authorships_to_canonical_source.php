<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Structured author list: name, openalex_author_id, orcid, position, is_corresponding.
        // Stored as JSONB so ORCID lookups via the GIN index can find canonicals by author identity
        // (basis for future is_publisher_uploaded / author_version_book auto-flagging).
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source ADD COLUMN authorships jsonb NULL
        ");

        DB::connection('pgsql_admin')->statement("
            CREATE INDEX canonical_source_authorships_idx ON canonical_source USING gin (authorships)
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP INDEX IF EXISTS canonical_source_authorships_idx");
        DB::connection('pgsql_admin')->statement("ALTER TABLE canonical_source DROP COLUMN IF EXISTS authorships");
    }
};
