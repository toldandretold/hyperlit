<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Creates composite unique indexes required for PostgreSQL UPSERT (ON CONFLICT)
     * to work with bulk operations in DbNodeChunkController::bulkTargetedUpsert()
     */
    public function up(): void
    {
        // Drop existing single-column unique constraint if it exists
        // (It's a constraint, not just an index)
        DB::statement('ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_node_id_unique');

        // Clean up duplicate (book, startLine) combinations before creating unique index
        // Keep the record with the latest updated_at, delete older duplicates
        DB::statement('
            DELETE FROM nodes
            WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY book, "startLine"
                        ORDER BY updated_at DESC NULLS LAST, id DESC
                    ) as rn
                    FROM nodes
                ) sub
                WHERE rn > 1
            )
        ');

        // Create composite unique index for (book, node_id) - PRIMARY lookup
        // Partial index allows multiple NULL values for node_id
        DB::statement('
            CREATE UNIQUE INDEX nodes_book_node_id_unique
            ON nodes (book, node_id)
            WHERE node_id IS NOT NULL
        ');

        // Create composite unique index for (book, startLine) - FALLBACK lookup
        DB::statement('
            CREATE UNIQUE INDEX nodes_book_startline_unique
            ON nodes (book, "startLine")
        ');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS nodes_book_startline_unique');
        DB::statement('DROP INDEX IF EXISTS nodes_book_node_id_unique');
    }
};
