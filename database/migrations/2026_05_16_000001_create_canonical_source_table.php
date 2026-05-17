<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE canonical_source (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

                title text NULL,
                author text NULL,
                year integer NULL,
                journal text NULL,
                publisher text NULL,
                abstract text NULL,
                type varchar(50) NULL,
                language varchar(10) NULL,

                doi text NULL,
                openalex_id varchar(30) NULL,
                open_library_key varchar(50) NULL,

                is_oa boolean NULL,
                oa_status varchar(20) NULL,
                cited_by_count integer NULL,

                creator varchar NULL,
                creator_token uuid NULL,
                foundation_source varchar(50) NULL,

                verified_by_publisher boolean NOT NULL DEFAULT false,
                commons_endorsements integer NOT NULL DEFAULT 0,

                author_version_book varchar(255) NULL,
                publisher_version_book varchar(255) NULL,
                commons_version_book varchar(255) NULL,

                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement("CREATE INDEX canonical_source_openalex_id_idx ON canonical_source (openalex_id)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX canonical_source_open_library_key_idx ON canonical_source (open_library_key)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX canonical_source_doi_idx ON canonical_source (doi)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX canonical_source_foundation_source_idx ON canonical_source (foundation_source)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX canonical_source_creator_token_idx ON canonical_source (creator_token)");

        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON canonical_source TO {$appUser}");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS canonical_source");
    }
};
