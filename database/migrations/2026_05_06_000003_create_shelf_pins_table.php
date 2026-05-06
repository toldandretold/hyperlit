<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create the shelf_pins table with RLS policies.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE shelf_pins (
                shelf_key varchar NOT NULL,
                book varchar NOT NULL,
                position double precision NOT NULL DEFAULT 0,
                creator varchar NOT NULL,
                creator_token uuid NULL,
                PRIMARY KEY (shelf_key, book)
            )
        ");

        DB::connection('pgsql_admin')->statement("CREATE INDEX shelf_pins_creator_idx ON shelf_pins (creator)");

        // Grant permissions to app user
        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON shelf_pins TO {$appUser}");

        // Enable RLS
        DB::connection('pgsql_admin')->statement("ALTER TABLE shelf_pins ENABLE ROW LEVEL SECURITY");
        DB::connection('pgsql_admin')->statement("ALTER TABLE shelf_pins FORCE ROW LEVEL SECURITY");

        // SELECT: Users see only their own pins
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelf_pins_select_policy ON shelf_pins
            FOR SELECT
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: Must have valid session
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelf_pins_insert_policy ON shelf_pins
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // UPDATE: Only owners can update
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelf_pins_update_policy ON shelf_pins
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // DELETE: Only authenticated user can delete
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelf_pins_delete_policy ON shelf_pins
            FOR DELETE
            USING (
                creator IS NOT NULL
                AND creator = current_setting('app.current_user', true)
                AND current_setting('app.current_user', true) IS NOT NULL
                AND current_setting('app.current_user', true) != ''
            )
        ");
    }

    /**
     * Reverse the migration.
     */
    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelf_pins_delete_policy ON shelf_pins");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelf_pins_update_policy ON shelf_pins");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelf_pins_insert_policy ON shelf_pins");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelf_pins_select_policy ON shelf_pins");
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS shelf_pins");
    }
};
