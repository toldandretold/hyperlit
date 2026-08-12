<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE journal_sources (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

                openalex_source_id varchar(30) NOT NULL UNIQUE,
                issn_l varchar(9) NULL,
                issns jsonb NULL,
                display_name text NOT NULL,
                publisher text NULL,
                slug varchar(150) NOT NULL UNIQUE,

                is_diamond boolean NOT NULL DEFAULT false,
                diamond_provenance varchar(30) NULL,
                is_oa boolean NULL,
                is_in_doaj boolean NULL,
                apc_usd integer NULL,

                works_count integer NULL,
                cited_by_count bigint NULL,
                two_year_mean_citedness numeric NULL,

                country_code varchar(2) NULL,
                languages jsonb NULL,
                homepage_url text NULL,
                topics jsonb NULL,

                last_synced_at timestamp NULL,
                last_harvested_at timestamp NULL,
                harvest_stats jsonb NULL,
                shelf_id uuid NULL,

                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement("CREATE INDEX journal_sources_cited_by_count_idx ON journal_sources (cited_by_count DESC NULLS LAST)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX journal_sources_issn_l_idx ON journal_sources (issn_l)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX journal_sources_is_diamond_idx ON journal_sources (is_diamond)");

        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON journal_sources TO {$appUser}");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS journal_sources");
    }
};
