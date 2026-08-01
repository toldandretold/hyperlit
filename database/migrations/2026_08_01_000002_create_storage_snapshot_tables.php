<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Storage snapshots — what Hyperlit is holding, measured over time.
 *
 * One row per scan in `storage_scans`, and one row per (book × category ×
 * subtype) in `storage_scan_items`. Deliberately aggregated per BOOK, never per
 * file: the dev tree alone has ~70k files, and per-file rows would make the
 * measurement bigger than the thing measured.
 *
 * `owner` is denormalised from library.creator at scan time on purpose — it is
 * the seam that makes the future per-user footprint page a `where owner = ?`
 * filter over this same data rather than a second measurement system.
 *
 * No RLS yet: both readers are admin-gated maintainer endpoints. When the
 * user-facing page ships, either add policies mirroring `library`, or have the
 * user endpoint filter by owner server-side — do NOT expose these tables to the
 * app role's read path unchanged.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement('
            CREATE TABLE storage_scans (
                id bigserial PRIMARY KEY,
                started_at timestamp NOT NULL,
                finished_at timestamp NULL,
                duration_ms integer NULL,
                total_bytes bigint NOT NULL DEFAULT 0,
                db_bytes bigint NOT NULL DEFAULT 0,
                file_bytes bigint NOT NULL DEFAULT 0,
                orphan_bytes bigint NOT NULL DEFAULT 0,
                disk_free_bytes bigint NULL,
                disk_total_bytes bigint NULL,
                notes jsonb NULL,
                created_at timestamp NOT NULL DEFAULT NOW()
            )
        ');

        DB::connection('pgsql_admin')->statement('
            CREATE TABLE storage_scan_items (
                id bigserial PRIMARY KEY,
                scan_id bigint NOT NULL REFERENCES storage_scans(id) ON DELETE CASCADE,
                book varchar(255) NULL,            -- root book id; NULL for non-book data
                owner varchar(255) NULL,           -- library.creator at scan time
                category varchar(32) NOT NULL,     -- database|documents|images|audio|cache|legacy_images|other
                subtype varchar(96) NULL,          -- table name, file extension, or bucket
                bytes bigint NOT NULL DEFAULT 0,
                file_count integer NOT NULL DEFAULT 0,
                path text NULL,                    -- set for orphans so reclaim acts on what was reported
                is_orphan boolean NOT NULL DEFAULT false
            )
        ');

        foreach ([
            'CREATE INDEX storage_scan_items_scan_category_idx ON storage_scan_items (scan_id, category)',
            'CREATE INDEX storage_scan_items_scan_book_idx ON storage_scan_items (scan_id, book)',
            'CREATE INDEX storage_scan_items_scan_owner_idx ON storage_scan_items (scan_id, owner)',
            'CREATE INDEX storage_scan_items_orphan_idx ON storage_scan_items (scan_id, is_orphan)',
        ] as $sql) {
            DB::connection('pgsql_admin')->statement($sql);
        }

        foreach (['storage_scans', 'storage_scan_items'] as $table) {
            DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON {$table} TO {$appUser}");
        }
        DB::connection('pgsql_admin')->statement("GRANT USAGE, SELECT ON SEQUENCE storage_scans_id_seq TO {$appUser}");
        DB::connection('pgsql_admin')->statement("GRANT USAGE, SELECT ON SEQUENCE storage_scan_items_id_seq TO {$appUser}");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS storage_scan_items');
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS storage_scans');
    }
};
