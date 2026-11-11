<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Where a work's licence came from, and what every source said about it.
 *
 *  - license_evidence            one row per (book, source) that `library:discover-licenses`
 *                                consulted — INCLUDING sources that said nothing (raw NULL), so
 *                                "why is this still Unknown?" has an answer and
 *                                `select source, mapped_code, count(*)` is the audit.
 *  - library.license_source      which source the stored code came from (`crossref`,
 *                                `fetch_trace`, `status`, … or `user` when a person chose it —
 *                                discovery never overwrites a `user` row).
 *  - library.license_checked_at  last discovery pass over this row (resumability + cooldown:
 *                                upstream metadata improves, so a still-Unknown row is retried
 *                                after a month rather than never or every night).
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');
        $admin = DB::connection('pgsql_admin');

        $admin->statement('ALTER TABLE library ADD COLUMN IF NOT EXISTS license_source varchar(32) NULL');
        $admin->statement('ALTER TABLE library ADD COLUMN IF NOT EXISTS license_checked_at timestamptz NULL');

        $admin->statement('
            CREATE TABLE IF NOT EXISTS license_evidence (
                id bigserial PRIMARY KEY,
                book varchar(255) NOT NULL,
                source varchar(32) NOT NULL,
                raw text NULL,
                mapped_code varchar(100) NULL,
                version_stated boolean NOT NULL DEFAULT false,
                note text NULL,
                checked_at timestamptz NOT NULL DEFAULT NOW(),
                UNIQUE (book, source)
            )
        ');
        $admin->statement('ALTER TABLE license_evidence ADD COLUMN IF NOT EXISTS note text NULL');
        $admin->statement('CREATE INDEX IF NOT EXISTS license_evidence_source_code_idx ON license_evidence (source, mapped_code)');

        $admin->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON license_evidence TO {$appUser}");
        $admin->statement("GRANT USAGE, SELECT ON SEQUENCE license_evidence_id_seq TO {$appUser}");
    }

    public function down(): void
    {
        $admin = DB::connection('pgsql_admin');
        $admin->statement('DROP TABLE IF EXISTS license_evidence');
        $admin->statement('ALTER TABLE library DROP COLUMN IF EXISTS license_checked_at');
        $admin->statement('ALTER TABLE library DROP COLUMN IF EXISTS license_source');
    }
};
