<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Enable Row Level Security and create policies.
     *
     * IMPORTANT: This migration must be run with admin/superuser privileges.
     * Run: php artisan migrate --database=pgsql_admin
     *
     * Session variables used by middleware:
     * - app.current_user: Username for authenticated users (empty for anonymous)
     * - app.current_token: UUID token for anonymous users (empty for authenticated)
     * - app.session_id: Laravel session ID (for sessions table protection)
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // ==========================================
        // LIBRARY TABLE POLICIES
        // ==========================================

        DB::statement("ALTER TABLE library ENABLE ROW LEVEL SECURITY");
        DB::statement("ALTER TABLE library FORCE ROW LEVEL SECURITY");

        // SELECT: Public books visible to all, private books only to owner
        DB::statement("
            CREATE POLICY library_select_policy ON library
            FOR SELECT
            USING (
                visibility = 'public'
                OR (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: Must have valid session (creator info set by application)
        DB::statement("
            CREATE POLICY library_insert_policy ON library
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // UPDATE: Only owners can update
        DB::statement("
            CREATE POLICY library_update_policy ON library
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // DELETE: Only authenticated owners can delete (not anonymous)
        DB::statement("
            CREATE POLICY library_delete_policy ON library
            FOR DELETE
            USING (
                creator IS NOT NULL
                AND creator = current_setting('app.current_user', true)
                AND current_setting('app.current_user', true) IS NOT NULL
                AND current_setting('app.current_user', true) != ''
            )
        ");

        // ==========================================
        // HYPERLIGHTS TABLE POLICIES
        // ==========================================

        DB::statement("ALTER TABLE hyperlights ENABLE ROW LEVEL SECURITY");
        DB::statement("ALTER TABLE hyperlights FORCE ROW LEVEL SECURITY");

        // SELECT: Can see highlights on public books or own highlights
        DB::statement("
            CREATE POLICY hyperlights_select_policy ON hyperlights
            FOR SELECT
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = hyperlights.book
                    AND library.visibility = 'public'
                )
                OR (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: Must have valid session
        DB::statement("
            CREATE POLICY hyperlights_insert_policy ON hyperlights
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // UPDATE: Only own highlights
        DB::statement("
            CREATE POLICY hyperlights_update_policy ON hyperlights
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // DELETE: Only own highlights
        DB::statement("
            CREATE POLICY hyperlights_delete_policy ON hyperlights
            FOR DELETE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // ==========================================
        // HYPERCITES TABLE POLICIES (same pattern)
        // ==========================================

        DB::statement("ALTER TABLE hypercites ENABLE ROW LEVEL SECURITY");
        DB::statement("ALTER TABLE hypercites FORCE ROW LEVEL SECURITY");

        DB::statement("
            CREATE POLICY hypercites_select_policy ON hypercites
            FOR SELECT
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = hypercites.book
                    AND library.visibility = 'public'
                )
                OR (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_insert_policy ON hypercites
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_update_policy ON hypercites
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_delete_policy ON hypercites
            FOR DELETE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // ==========================================
        // NODES TABLE POLICIES
        // Nodes inherit access from their parent book
        // ==========================================

        DB::statement("ALTER TABLE nodes ENABLE ROW LEVEL SECURITY");
        DB::statement("ALTER TABLE nodes FORCE ROW LEVEL SECURITY");

        // SELECT: Can see nodes from public books or books you own
        DB::statement("
            CREATE POLICY nodes_select_policy ON nodes
            FOR SELECT
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = nodes.book
                    AND (
                        library.visibility = 'public'
                        OR (library.creator IS NOT NULL AND library.creator = current_setting('app.current_user', true))
                        OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                )
            )
        ");

        // INSERT/UPDATE/DELETE: Only book owners can modify nodes
        DB::statement("
            CREATE POLICY nodes_insert_policy ON nodes
            FOR INSERT
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = nodes.book
                    AND (
                        (library.creator IS NOT NULL AND library.creator = current_setting('app.current_user', true))
                        OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                )
            )
        ");

        DB::statement("
            CREATE POLICY nodes_update_policy ON nodes
            FOR UPDATE
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = nodes.book
                    AND (
                        (library.creator IS NOT NULL AND library.creator = current_setting('app.current_user', true))
                        OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                )
            )
        ");

        DB::statement("
            CREATE POLICY nodes_delete_policy ON nodes
            FOR DELETE
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = nodes.book
                    AND (
                        (library.creator IS NOT NULL AND library.creator = current_setting('app.current_user', true))
                        OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                )
            )
        ");

        // ==========================================
        // FOOTNOTES & BIBLIOGRAPHY (book-owned content)
        // ==========================================

        foreach (['footnotes', 'bibliography'] as $table) {
            DB::statement("ALTER TABLE {$table} ENABLE ROW LEVEL SECURITY");
            DB::statement("ALTER TABLE {$table} FORCE ROW LEVEL SECURITY");

            DB::statement("
                CREATE POLICY {$table}_select_policy ON {$table}
                FOR SELECT
                USING (
                    EXISTS (
                        SELECT 1 FROM library
                        WHERE library.book = {$table}.book
                        AND (
                            library.visibility = 'public'
                            OR (library.creator IS NOT NULL AND library.creator = current_setting('app.current_user', true))
                            OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                        )
                    )
                )
            ");

            DB::statement("
                CREATE POLICY {$table}_insert_policy ON {$table}
                FOR INSERT
                WITH CHECK (
                    EXISTS (
                        SELECT 1 FROM library
                        WHERE library.book = {$table}.book
                        AND (
                            (library.creator IS NOT NULL AND library.creator = current_setting('app.current_user', true))
                            OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                        )
                    )
                )
            ");

            DB::statement("
                CREATE POLICY {$table}_update_policy ON {$table}
                FOR UPDATE
                USING (
                    EXISTS (
                        SELECT 1 FROM library
                        WHERE library.book = {$table}.book
                        AND (
                            (library.creator IS NOT NULL AND library.creator = current_setting('app.current_user', true))
                            OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                        )
                    )
                )
            ");

            DB::statement("
                CREATE POLICY {$table}_delete_policy ON {$table}
                FOR DELETE
                USING (
                    EXISTS (
                        SELECT 1 FROM library
                        WHERE library.book = {$table}.book
                        AND (
                            (library.creator IS NOT NULL AND library.creator = current_setting('app.current_user', true))
                            OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                        )
                    )
                )
            ");
        }

        // ==========================================
        // ANONYMOUS_SESSIONS - Highly restricted
        // Users can only see/modify their own session
        // ==========================================

        DB::statement("ALTER TABLE anonymous_sessions ENABLE ROW LEVEL SECURITY");
        DB::statement("ALTER TABLE anonymous_sessions FORCE ROW LEVEL SECURITY");

        // SELECT: Only your own session
        DB::statement("
            CREATE POLICY anonymous_sessions_select_policy ON anonymous_sessions
            FOR SELECT
            USING (
                token = current_setting('app.current_token', true)
            )
        ");

        // INSERT: Allow creating new sessions (rate limiting done via cache)
        DB::statement("
            CREATE POLICY anonymous_sessions_insert_policy ON anonymous_sessions
            FOR INSERT
            WITH CHECK (true)
        ");

        // UPDATE: Only your own session
        DB::statement("
            CREATE POLICY anonymous_sessions_update_policy ON anonymous_sessions
            FOR UPDATE
            USING (
                token = current_setting('app.current_token', true)
            )
        ");

        // No DELETE policy - sessions expire naturally

        // ==========================================
        // USERS TABLE - Restricted with auth bypass
        // ==========================================

        DB::statement("ALTER TABLE users ENABLE ROW LEVEL SECURITY");
        DB::statement("ALTER TABLE users FORCE ROW LEVEL SECURITY");

        // SELECT: Only your own record
        DB::statement("
            CREATE POLICY users_select_policy ON users
            FOR SELECT
            USING (
                name = current_setting('app.current_user', true)
            )
        ");

        // INSERT: Allow registration (user doesn't exist yet)
        DB::statement("
            CREATE POLICY users_insert_policy ON users
            FOR INSERT
            WITH CHECK (true)
        ");

        // UPDATE: Only your own record
        DB::statement("
            CREATE POLICY users_update_policy ON users
            FOR UPDATE
            USING (
                name = current_setting('app.current_user', true)
            )
        ");

        // DELETE: Only your own record
        DB::statement("
            CREATE POLICY users_delete_policy ON users
            FOR DELETE
            USING (
                name = current_setting('app.current_user', true)
            )
        ");

        // Create SECURITY DEFINER function for authentication
        // This bypasses RLS to allow login lookups
        DB::statement("
            CREATE OR REPLACE FUNCTION auth_lookup_user(p_email text)
            RETURNS TABLE(id bigint, password varchar, remember_token varchar)
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, password, remember_token
                FROM users
                WHERE email = p_email
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        // Restrict who can call the auth function
        DB::statement("REVOKE EXECUTE ON FUNCTION auth_lookup_user(text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION auth_lookup_user(text) TO {$appUser}");

        // ==========================================
        // SESSIONS TABLE - Prevent session hijacking
        // ==========================================

        DB::statement("ALTER TABLE sessions ENABLE ROW LEVEL SECURITY");
        DB::statement("ALTER TABLE sessions FORCE ROW LEVEL SECURITY");

        // All operations restricted to your own session
        DB::statement("
            CREATE POLICY sessions_select_policy ON sessions
            FOR SELECT
            USING (
                id = current_setting('app.session_id', true)
            )
        ");

        DB::statement("
            CREATE POLICY sessions_insert_policy ON sessions
            FOR INSERT
            WITH CHECK (true)
        ");

        DB::statement("
            CREATE POLICY sessions_update_policy ON sessions
            FOR UPDATE
            USING (
                id = current_setting('app.session_id', true)
            )
        ");

        DB::statement("
            CREATE POLICY sessions_delete_policy ON sessions
            FOR DELETE
            USING (
                id = current_setting('app.session_id', true)
            )
        ");
    }

    public function down(): void
    {
        // Tables with RLS policies
        $tables = [
            'library',
            'hyperlights',
            'hypercites',
            'nodes',
            'footnotes',
            'bibliography',
            'anonymous_sessions',
            'users',
            'sessions',
        ];

        // Policy suffixes used
        $policySuffixes = ['select', 'insert', 'update', 'delete'];

        foreach ($tables as $table) {
            foreach ($policySuffixes as $suffix) {
                DB::statement("DROP POLICY IF EXISTS {$table}_{$suffix}_policy ON {$table}");
            }
            DB::statement("ALTER TABLE {$table} DISABLE ROW LEVEL SECURITY");
        }

        // Drop the auth function
        DB::statement("DROP FUNCTION IF EXISTS auth_lookup_user(text)");
    }
};
