<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Update RLS policies to require creator_token for authorization.
     *
     * Previously, policies allowed access if EITHER:
     * - creator = username (public info - attackable)
     * - OR creator_token = token (secret UUID - secure)
     *
     * Now policies require creator_token match for private content:
     * - Public content: Anyone can see
     * - Private content: Must have matching creator_token
     *
     * The username (creator) is still stored for display purposes but
     * is no longer used for RLS authorization decisions.
     *
     * IMPORTANT: This migration must be run with admin/superuser privileges.
     * Run: php artisan migrate --database=pgsql_admin
     */
    public function up(): void
    {
        // ==========================================
        // LIBRARY TABLE - Updated policies
        // ==========================================

        // Drop existing policies
        DB::statement("DROP POLICY IF EXISTS library_select_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_insert_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_update_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_delete_policy ON library");

        // SELECT: Public books visible to all, private books only to token owner
        DB::statement("
            CREATE POLICY library_select_policy ON library
            FOR SELECT
            USING (
                visibility = 'public'
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: Must have valid token
        DB::statement("
            CREATE POLICY library_insert_policy ON library
            FOR INSERT
            WITH CHECK (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        // UPDATE: Only token owners can update
        DB::statement("
            CREATE POLICY library_update_policy ON library
            FOR UPDATE
            USING (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        // DELETE: Only authenticated token owners can delete (check for non-empty username)
        DB::statement("
            CREATE POLICY library_delete_policy ON library
            FOR DELETE
            USING (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
                AND creator IS NOT NULL
                AND current_setting('app.current_user', true) IS NOT NULL
                AND current_setting('app.current_user', true) != ''
            )
        ");

        // ==========================================
        // HYPERLIGHTS TABLE - Updated policies
        // ==========================================

        DB::statement("DROP POLICY IF EXISTS hyperlights_select_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_insert_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_update_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_delete_policy ON hyperlights");

        // SELECT: Can see highlights on public books or own highlights (by token)
        DB::statement("
            CREATE POLICY hyperlights_select_policy ON hyperlights
            FOR SELECT
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = hyperlights.book
                    AND library.visibility = 'public'
                )
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: Must have valid token
        DB::statement("
            CREATE POLICY hyperlights_insert_policy ON hyperlights
            FOR INSERT
            WITH CHECK (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        // UPDATE: Only own highlights (by token)
        DB::statement("
            CREATE POLICY hyperlights_update_policy ON hyperlights
            FOR UPDATE
            USING (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        // DELETE: Only own highlights (by token)
        DB::statement("
            CREATE POLICY hyperlights_delete_policy ON hyperlights
            FOR DELETE
            USING (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        // ==========================================
        // HYPERCITES TABLE - Updated policies
        // ==========================================

        DB::statement("DROP POLICY IF EXISTS hypercites_select_policy ON hypercites");
        DB::statement("DROP POLICY IF EXISTS hypercites_insert_policy ON hypercites");
        DB::statement("DROP POLICY IF EXISTS hypercites_update_policy ON hypercites");
        DB::statement("DROP POLICY IF EXISTS hypercites_delete_policy ON hypercites");

        DB::statement("
            CREATE POLICY hypercites_select_policy ON hypercites
            FOR SELECT
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = hypercites.book
                    AND library.visibility = 'public'
                )
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_insert_policy ON hypercites
            FOR INSERT
            WITH CHECK (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_update_policy ON hypercites
            FOR UPDATE
            USING (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_delete_policy ON hypercites
            FOR DELETE
            USING (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        // ==========================================
        // NODES TABLE - Updated policies (inherit from book)
        // ==========================================

        DB::statement("DROP POLICY IF EXISTS nodes_select_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_insert_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_update_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_delete_policy ON nodes");

        // SELECT: Can see nodes from public books or books you own (by token)
        DB::statement("
            CREATE POLICY nodes_select_policy ON nodes
            FOR SELECT
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = nodes.book
                    AND (
                        library.visibility = 'public'
                        OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                )
            )
        ");

        // INSERT/UPDATE/DELETE: Only book owners (by token) can modify nodes
        DB::statement("
            CREATE POLICY nodes_insert_policy ON nodes
            FOR INSERT
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = nodes.book
                    AND library.creator_token IS NOT NULL
                    AND library.creator_token::text = current_setting('app.current_token', true)
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
                    AND library.creator_token IS NOT NULL
                    AND library.creator_token::text = current_setting('app.current_token', true)
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
                    AND library.creator_token IS NOT NULL
                    AND library.creator_token::text = current_setting('app.current_token', true)
                )
            )
        ");

        // ==========================================
        // FOOTNOTES & BIBLIOGRAPHY - Updated policies
        // ==========================================

        foreach (['footnotes', 'bibliography'] as $table) {
            DB::statement("DROP POLICY IF EXISTS {$table}_select_policy ON {$table}");
            DB::statement("DROP POLICY IF EXISTS {$table}_insert_policy ON {$table}");
            DB::statement("DROP POLICY IF EXISTS {$table}_update_policy ON {$table}");
            DB::statement("DROP POLICY IF EXISTS {$table}_delete_policy ON {$table}");

            DB::statement("
                CREATE POLICY {$table}_select_policy ON {$table}
                FOR SELECT
                USING (
                    EXISTS (
                        SELECT 1 FROM library
                        WHERE library.book = {$table}.book
                        AND (
                            library.visibility = 'public'
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
                        AND library.creator_token IS NOT NULL
                        AND library.creator_token::text = current_setting('app.current_token', true)
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
                        AND library.creator_token IS NOT NULL
                        AND library.creator_token::text = current_setting('app.current_token', true)
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
                        AND library.creator_token IS NOT NULL
                        AND library.creator_token::text = current_setting('app.current_token', true)
                    )
                )
            ");
        }
    }

    public function down(): void
    {
        // Revert to old policies that use OR between username and token
        // This is the less secure version - only for rollback purposes

        // LIBRARY
        DB::statement("DROP POLICY IF EXISTS library_select_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_insert_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_update_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_delete_policy ON library");

        DB::statement("
            CREATE POLICY library_select_policy ON library
            FOR SELECT
            USING (
                visibility = 'public'
                OR (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY library_insert_policy ON library
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY library_update_policy ON library
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

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

        // HYPERLIGHTS
        DB::statement("DROP POLICY IF EXISTS hyperlights_select_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_insert_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_update_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_delete_policy ON hyperlights");

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

        DB::statement("
            CREATE POLICY hyperlights_insert_policy ON hyperlights
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hyperlights_update_policy ON hyperlights
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hyperlights_delete_policy ON hyperlights
            FOR DELETE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // HYPERCITES
        DB::statement("DROP POLICY IF EXISTS hypercites_select_policy ON hypercites");
        DB::statement("DROP POLICY IF EXISTS hypercites_insert_policy ON hypercites");
        DB::statement("DROP POLICY IF EXISTS hypercites_update_policy ON hypercites");
        DB::statement("DROP POLICY IF EXISTS hypercites_delete_policy ON hypercites");

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

        // NODES - revert to old policies
        DB::statement("DROP POLICY IF EXISTS nodes_select_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_insert_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_update_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_delete_policy ON nodes");

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

        // FOOTNOTES & BIBLIOGRAPHY - revert
        foreach (['footnotes', 'bibliography'] as $table) {
            DB::statement("DROP POLICY IF EXISTS {$table}_select_policy ON {$table}");
            DB::statement("DROP POLICY IF EXISTS {$table}_insert_policy ON {$table}");
            DB::statement("DROP POLICY IF EXISTS {$table}_update_policy ON {$table}");
            DB::statement("DROP POLICY IF EXISTS {$table}_delete_policy ON {$table}");

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
    }
};
