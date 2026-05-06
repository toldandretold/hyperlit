<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create the shelves table with RLS policies.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE shelves (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                creator varchar NOT NULL,
                creator_token uuid NULL,
                name varchar(255) NOT NULL,
                description text NULL,
                visibility varchar(20) NOT NULL DEFAULT 'private',
                default_sort varchar(30) NOT NULL DEFAULT 'recent',
                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement("CREATE INDEX shelves_creator_idx ON shelves (creator)");
        DB::connection('pgsql_admin')->statement("CREATE UNIQUE INDEX shelves_creator_name_unique ON shelves (creator, name)");

        // Grant permissions to app user
        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON shelves TO {$appUser}");

        // Enable RLS
        DB::connection('pgsql_admin')->statement("ALTER TABLE shelves ENABLE ROW LEVEL SECURITY");
        DB::connection('pgsql_admin')->statement("ALTER TABLE shelves FORCE ROW LEVEL SECURITY");

        // SELECT: Users see only their own shelves
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelves_select_policy ON shelves
            FOR SELECT
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: Must have valid session
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelves_insert_policy ON shelves
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // UPDATE: Only owners can update
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelves_update_policy ON shelves
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // DELETE: Only authenticated user can delete (not anonymous)
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY shelves_delete_policy ON shelves
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
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelves_delete_policy ON shelves");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelves_update_policy ON shelves");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelves_insert_policy ON shelves");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS shelves_select_policy ON shelves");
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS shelves");
    }
};
