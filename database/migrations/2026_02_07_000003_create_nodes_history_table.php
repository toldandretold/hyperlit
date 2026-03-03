<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create nodes_history table to store archived versions of nodes.
     *
     * This table mirrors the nodes table structure but:
     * - Has no unique constraints (can have multiple versions of same node)
     * - Removes generated columns (search_vector, search_vector_simple)
     * - Adds history_id as the primary key
     * - Has indexes optimized for temporal queries
     */
    public function up(): void
    {
        // Create history table by copying structure from nodes
        // INCLUDING DEFAULTS copies default values for columns
        DB::connection('pgsql_admin')->statement('CREATE TABLE IF NOT EXISTS nodes_history (LIKE nodes INCLUDING DEFAULTS)');

        // Remove the primary key constraint (history can have duplicates)
        DB::connection('pgsql_admin')->statement('ALTER TABLE nodes_history DROP CONSTRAINT IF EXISTS nodes_history_pkey');

        // Remove unique constraints that shouldn't exist in history
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS nodes_history_book_node_id_unique');
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS nodes_history_book_startline_unique');
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS nodes_history_node_id_index');

        // Remove generated columns (they can't be inserted into and aren't needed in history)
        DB::connection('pgsql_admin')->statement('ALTER TABLE nodes_history DROP COLUMN IF EXISTS search_vector');
        DB::connection('pgsql_admin')->statement('ALTER TABLE nodes_history DROP COLUMN IF EXISTS search_vector_simple');

        // Add a new auto-increment primary key for history entries
        DB::connection('pgsql_admin')->statement('ALTER TABLE nodes_history ADD COLUMN IF NOT EXISTS history_id BIGSERIAL PRIMARY KEY');

        // Create indexes optimized for temporal queries

        // GIST index on sys_period for point-in-time queries: WHERE sys_period @> timestamp
        DB::connection('pgsql_admin')->statement("
            CREATE INDEX IF NOT EXISTS nodes_history_sys_period_idx
            ON nodes_history USING GIST (sys_period)
        ");

        // Composite index for "get all versions of a specific node" queries
        DB::connection('pgsql_admin')->statement("
            CREATE INDEX IF NOT EXISTS nodes_history_book_node_id_idx
            ON nodes_history (book, node_id)
        ");

        // Index on book for book-wide history queries
        DB::connection('pgsql_admin')->statement("
            CREATE INDEX IF NOT EXISTS nodes_history_book_idx
            ON nodes_history (book)
        ");

        // Index for "get recent changes" queries (for undo UI)
        // upper(sys_period) is when the version was archived/superseded
        DB::connection('pgsql_admin')->statement("
            CREATE INDEX IF NOT EXISTS nodes_history_book_changed_at_idx
            ON nodes_history (book, upper(sys_period) DESC NULLS LAST)
        ");

        // Grant permissions to app user
        $appUser = env('DB_USERNAME', 'hyperlit_app');
        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT ON nodes_history TO {$appUser}");
        DB::connection('pgsql_admin')->statement("GRANT USAGE, SELECT ON SEQUENCE nodes_history_history_id_seq TO {$appUser}");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS nodes_history CASCADE');
    }
};
