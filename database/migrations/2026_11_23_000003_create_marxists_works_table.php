<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * The ledger of the marxists.org bulk import (docs/marxists-import.md): one row per WORK an
 * author's listing page links. `marxists:list` fills it; `marxists:import` walks it a batch at a
 * time, so a five-author import of several thousand works is resumable, never re-asks the site
 * for a work it already settled, and can be read back ("what failed, and why").
 *
 * Operator data: written only by App\Services\Marxists\MarxistsBulkImporter on pgsql_admin.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');
        $db = DB::connection('pgsql_admin');

        $db->statement("
            CREATE TABLE marxists_works (
                id bigserial PRIMARY KEY,

                url varchar(2048) NOT NULL UNIQUE,
                author varchar(100) NOT NULL,
                listing_url varchar(2048) NULL,
                link_title text NULL,
                kind varchar(30) NULL,

                status varchar(20) NOT NULL DEFAULT 'listed',
                reason text NULL,
                book varchar NULL,
                same_title_as varchar NULL,

                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");
        $db->statement('CREATE INDEX marxists_works_author_status_idx ON marxists_works (author, status, id)');
        $db->statement("REVOKE ALL ON marxists_works FROM {$appUser}");
        $db->statement("GRANT SELECT ON marxists_works TO {$appUser}");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS marxists_works');
    }
};
