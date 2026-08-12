<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Journal "about" metadata for the /j/{slug} home pages: operator-set copy
 * (about, null = auto-compose) plus the DOAJ-sourced parts the default copy
 * composes from (keywords, LCC subjects, license, peer-review process,
 * society/institution, and the DOAJ ref URLs — aims & scope, journal site,
 * editorial board, OA statement, author instructions).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE journal_sources
                ADD COLUMN about text NULL,
                ADD COLUMN keywords jsonb NULL,
                ADD COLUMN subjects jsonb NULL,
                ADD COLUMN doaj_license varchar(100) NULL,
                ADD COLUMN review_process varchar(150) NULL,
                ADD COLUMN institution text NULL,
                ADD COLUMN ref_urls jsonb NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE journal_sources
                DROP COLUMN IF EXISTS about,
                DROP COLUMN IF EXISTS keywords,
                DROP COLUMN IF EXISTS subjects,
                DROP COLUMN IF EXISTS doaj_license,
                DROP COLUMN IF EXISTS review_process,
                DROP COLUMN IF EXISTS institution,
                DROP COLUMN IF EXISTS ref_urls
        ");
    }
};
