<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Drop the legacy single-column UNIQUE(node_id) on `nodes`, whatever it is called.
 *
 * 2025_12_12_134055 already meant to do this — it replaced the global unique with the
 * composite `nodes_book_node_id_unique` that DbNodeController::upsert()'s
 * `ON CONFLICT (book, node_id)` arbitrates against. But it dropped BY NAME:
 *
 *     ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_node_id_unique
 *
 * and that name only exists if 2025_11_15_081142 (which renames
 * `node_chunks_node_id_unique` → `nodes_node_id_unique`) actually ran on that database.
 * Where it did not, `IF EXISTS` silently no-opped and the database kept BOTH indexes —
 * exactly the state the dev box was found in on 2026-09-22.
 *
 * Why that is not cosmetic: `ON CONFLICT` only protects the arbiter index. A unique
 * violation on ANY OTHER index still aborts the statement. So two concurrent full-book
 * syncs of the same book — which is the NORMAL shape of a paste, the paste's own
 * `syncPasteToPostgreSQL` racing the unified sync — end with one of them dying on
 *
 *     SQLSTATE[23505]: duplicate key value violates unique constraint "node_chunks_node_id_unique"
 *
 * and a 500. The book is in IndexedDB, so the browser looks fine; the server just never
 * got that write. Found by the paste e2e corpus (mkdocs + xanadu fixtures), where the
 * server log shows the two upserts 14ms apart:
 *   Upsert completed {records_upserted: 319} … Upsert failed {23505 …}
 *
 * This migration looks the constraint up in the catalog by its DEFINITION rather than
 * trusting a name, so it converges any database whatever sequence of renames it has seen.
 */
return new class extends Migration
{
    public function up(): void
    {
        $connection = DB::connection('pgsql_admin');

        // Any UNIQUE constraint on `nodes` whose key is node_id ALONE. The composite
        // (book, node_id) index is a partial INDEX, not a constraint, so it cannot be
        // matched here by accident — but the array-length check makes that explicit.
        $legacy = $connection->select("
            SELECT c.conname
            FROM pg_constraint c
            WHERE c.conrelid = 'nodes'::regclass
              AND c.contype = 'u'
              AND array_length(c.conkey, 1) = 1
              AND c.conkey[1] = (
                  SELECT a.attnum FROM pg_attribute a
                  WHERE a.attrelid = 'nodes'::regclass AND a.attname = 'node_id'
              )
        ");

        foreach ($legacy as $constraint) {
            $connection->statement('ALTER TABLE nodes DROP CONSTRAINT '.$constraint->conname);
        }

        // Same shape as a bare unique INDEX (no constraint backing it), which is what a
        // hand-applied fix tends to leave behind.
        $legacyIndexes = $connection->select("
            SELECT i.relname AS indexname
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            WHERE x.indrelid = 'nodes'::regclass
              AND x.indisunique
              AND x.indnatts = 1
              AND x.indpred IS NULL
              AND i.relname <> 'nodes_book_node_id_unique'
              AND x.indkey[0] = (
                  SELECT a.attnum FROM pg_attribute a
                  WHERE a.attrelid = 'nodes'::regclass AND a.attname = 'node_id'
              )
        ");

        foreach ($legacyIndexes as $index) {
            $connection->statement('DROP INDEX IF EXISTS '.$index->indexname);
        }
    }

    /**
     * Deliberately irreversible. Re-creating a global UNIQUE(node_id) would reintroduce
     * the 23505, and on a database that has since accepted concurrent writes it could
     * fail outright — a down() that can break is worse than none.
     */
    public function down(): void
    {
        // no-op
    }
};
