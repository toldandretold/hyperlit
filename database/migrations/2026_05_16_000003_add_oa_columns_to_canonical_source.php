<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
                ADD COLUMN pdf_url text NULL,
                ADD COLUMN oa_url text NULL,
                ADD COLUMN work_license varchar(100) NULL,
                ADD COLUMN semantic_scholar_id varchar(50) NULL
        ");

        DB::connection('pgsql_admin')->statement(
            "CREATE INDEX canonical_source_semantic_scholar_id_idx ON canonical_source (semantic_scholar_id)"
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP INDEX IF EXISTS canonical_source_semantic_scholar_id_idx");
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
                DROP COLUMN IF EXISTS pdf_url,
                DROP COLUMN IF EXISTS oa_url,
                DROP COLUMN IF EXISTS work_license,
                DROP COLUMN IF EXISTS semantic_scholar_id
        ");
    }
};
