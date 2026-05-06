<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create the shelf_items table with RLS policies.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE shelf_items (
                shelf_id uuid NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
                book varchar NOT NULL,
                added_at timestamp DEFAULT NOW(),
                manual_position double precision NULL,
                PRIMARY KEY (shelf_id, book)
            )
        ");

        DB::connection('pgsql_admin')->statement("CREATE INDEX shelf_items_book_idx ON shelf_items (book)");

        // Grant permissions to app user
        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON shelf_items TO {$appUser}");

        // Enable RLS
        DB::connection('pgsql_admin')->statement("ALTER TABLE shelf_items ENABLE ROW LEVEL SECURITY");
        DB::connection('pgsql_admin')->statement("ALTER TABLE shelf_items FORCE ROW LEVEL SECURITY");

        // SELECT: Users can see items in their own shelves
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelf_items_select_policy ON shelf_items
            FOR SELECT
            USING (
                shelf_id IN (
                    SELECT id FROM shelves
                    WHERE (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                    OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
                )
            )
        ");

        // INSERT: Must own the shelf
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelf_items_insert_policy ON shelf_items
            FOR INSERT
            WITH CHECK (
                shelf_id IN (
                    SELECT id FROM shelves
                    WHERE (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                    OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
                )
            )
        ");

        // UPDATE: Must own the shelf
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelf_items_update_policy ON shelf_items
            FOR UPDATE
            USING (
                shelf_id IN (
                    SELECT id FROM shelves
                    WHERE (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                    OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
                )
            )
        ");

        // DELETE: Must own the shelf
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelf_items_delete_policy ON shelf_items
            FOR DELETE
            USING (
                shelf_id IN (
                    SELECT id FROM shelves
                    WHERE (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                    OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
                )
            )
        ");
    }

    /**
     * Reverse the migration.
     */
    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelf_items_delete_policy ON shelf_items");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelf_items_update_policy ON shelf_items");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelf_items_insert_policy ON shelf_items");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelf_items_select_policy ON shelf_items");
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS shelf_items");
    }
};
