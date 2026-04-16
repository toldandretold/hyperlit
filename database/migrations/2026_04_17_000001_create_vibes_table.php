<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create the vibes table with RLS policies.
     * All statements use the pgsql_admin connection explicitly.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Create the vibes table
        DB::connection('pgsql_admin')->statement("
            CREATE TABLE vibes (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                name varchar(100) NOT NULL,
                prompt varchar(500) NULL,
                css_overrides jsonb NOT NULL,
                visibility varchar(10) NOT NULL DEFAULT 'private',
                creator varchar NULL,
                creator_token uuid NULL,
                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");

        // Indexes
        DB::connection('pgsql_admin')->statement("CREATE INDEX vibes_creator_idx ON vibes (creator)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX vibes_visibility_created_idx ON vibes (visibility, created_at DESC)");

        // Grant permissions to app user
        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON vibes TO {$appUser}");

        // Enable RLS
        DB::connection('pgsql_admin')->statement("ALTER TABLE vibes ENABLE ROW LEVEL SECURITY");
        DB::connection('pgsql_admin')->statement("ALTER TABLE vibes FORCE ROW LEVEL SECURITY");

        // SELECT: Public vibes visible to all, private vibes only to owner
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY vibes_select_policy ON vibes
            FOR SELECT
            USING (
                visibility = 'public'
                OR (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: Must have valid session (creator info set by application)
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY vibes_insert_policy ON vibes
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // UPDATE: Only owners can update
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY vibes_update_policy ON vibes
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // DELETE: Only authenticated owners can delete (not anonymous)
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY vibes_delete_policy ON vibes
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
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS vibes_delete_policy ON vibes");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS vibes_update_policy ON vibes");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS vibes_insert_policy ON vibes");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS vibes_select_policy ON vibes");
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS vibes");
    }
};
