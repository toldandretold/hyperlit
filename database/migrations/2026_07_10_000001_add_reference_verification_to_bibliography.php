<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * A HUMAN decision layer on a bibliography reference's canonical match, kept ORTHOGONAL to the
     * pipeline-owned `match_method`/`match_score` (which the citation-scan job overwrites and a client
     * re-sync could touch). The book's author confirms or rejects "this reference matches canonical X"
     * from the citation card; that decision must survive re-scans/re-syncs, so it lives in its own
     * columns the pipeline never writes.
     *
     * Written only via pgsql_admin after a PHP owner check (authenticated users have no
     * library.creator_token, so an RLS-connection UPDATE on bibliography is blocked) — mirrors the
     * book-level SourceVerificationController flow.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE bibliography
            ADD COLUMN reference_match_method varchar(20) NULL,
            ADD COLUMN reference_verified_at  timestamptz  NULL,
            ADD COLUMN reference_verified_by  varchar      NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE bibliography
            DROP COLUMN IF EXISTS reference_match_method,
            DROP COLUMN IF EXISTS reference_verified_at,
            DROP COLUMN IF EXISTS reference_verified_by
        ");
    }
};
