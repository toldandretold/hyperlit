<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Refactor RLS policies to keep user_token ONLY in users table.
     *
     * Security improvement: Previously creator_token was stored in library/hyperlights/hypercites
     * which exposed the secret token to SQL injection attacks. Now:
     *
     * 1. Logged-in users: RLS JOINs to users table to verify user_token
     *    - user_token is protected by users table RLS (can only read your own record)
     *    - Even with SQL injection, attacker can't read victim's token
     *
     * 2. Anonymous users: creator_token used ONLY when creator IS NULL
     *    - Token only for anonymous content, less valuable target
     *
     * 3. User home pages: Special exception (raw_json->>'type' = 'user_home')
     *    - Public content, no secrets to protect
     *    - Allows page regeneration without token complexity
     *
     * IMPORTANT: Run with admin privileges: php artisan migrate --database=pgsql_admin
     */
    public function up(): void
    {
        // ==========================================
        // LIBRARY TABLE
        // ==========================================

        DB::statement("DROP POLICY IF EXISTS library_select_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_insert_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_update_policy ON library");
        DB::statement("DROP POLICY IF EXISTS library_delete_policy ON library");

        // SELECT: Public content, user home pages, logged-in owner (via users JOIN), or anonymous owner
        DB::statement("
            CREATE POLICY library_select_policy ON library
            FOR SELECT
            USING (
                visibility = 'public'
                OR (raw_json->>'type' = 'user_home')
                OR EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = library.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: User home pages, logged-in users (via JOIN), or anonymous users
        DB::statement("
            CREATE POLICY library_insert_policy ON library
            FOR INSERT
            WITH CHECK (
                (raw_json->>'type' = 'user_home')
                OR EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = library.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // UPDATE: User home pages, logged-in owners (via JOIN), or anonymous owners
        DB::statement("
            CREATE POLICY library_update_policy ON library
            FOR UPDATE
            USING (
                (raw_json->>'type' = 'user_home')
                OR EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = library.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // DELETE: Only logged-in users can delete (no user home page exception - those shouldn't be deleted)
        DB::statement("
            CREATE POLICY library_delete_policy ON library
            FOR DELETE
            USING (
                EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = library.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                AND current_setting('app.current_user', true) IS NOT NULL
                AND current_setting('app.current_user', true) != ''
            )
        ");

        // ==========================================
        // HYPERLIGHTS TABLE
        // ==========================================

        DB::statement("DROP POLICY IF EXISTS hyperlights_select_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_insert_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_update_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_delete_policy ON hyperlights");

        // SELECT: Public book highlights or own highlights
        DB::statement("
            CREATE POLICY hyperlights_select_policy ON hyperlights
            FOR SELECT
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = hyperlights.book
                    AND library.visibility = 'public'
                )
                OR EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = hyperlights.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (hyperlights.creator IS NULL AND hyperlights.creator_token IS NOT NULL AND hyperlights.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // INSERT: Logged-in users or anonymous users
        DB::statement("
            CREATE POLICY hyperlights_insert_policy ON hyperlights
            FOR INSERT
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = hyperlights.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (hyperlights.creator IS NULL AND hyperlights.creator_token IS NOT NULL AND hyperlights.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // UPDATE: Only own highlights
        DB::statement("
            CREATE POLICY hyperlights_update_policy ON hyperlights
            FOR UPDATE
            USING (
                EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = hyperlights.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (hyperlights.creator IS NULL AND hyperlights.creator_token IS NOT NULL AND hyperlights.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // DELETE: Only own highlights
        DB::statement("
            CREATE POLICY hyperlights_delete_policy ON hyperlights
            FOR DELETE
            USING (
                EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = hyperlights.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (hyperlights.creator IS NULL AND hyperlights.creator_token IS NOT NULL AND hyperlights.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // ==========================================
        // HYPERCITES TABLE (same pattern as hyperlights)
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
                OR EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = hypercites.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (hypercites.creator IS NULL AND hypercites.creator_token IS NOT NULL AND hypercites.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_insert_policy ON hypercites
            FOR INSERT
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = hypercites.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (hypercites.creator IS NULL AND hypercites.creator_token IS NOT NULL AND hypercites.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_update_policy ON hypercites
            FOR UPDATE
            USING (
                EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = hypercites.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (hypercites.creator IS NULL AND hypercites.creator_token IS NOT NULL AND hypercites.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_delete_policy ON hypercites
            FOR DELETE
            USING (
                EXISTS (
                    SELECT 1 FROM users
                    WHERE users.name = hypercites.creator
                    AND users.user_token::text = current_setting('app.current_token', true)
                )
                OR (hypercites.creator IS NULL AND hypercites.creator_token IS NOT NULL AND hypercites.creator_token::text = current_setting('app.current_token', true))
            )
        ");

        // ==========================================
        // NODES TABLE (inherits from library)
        // ==========================================

        DB::statement("DROP POLICY IF EXISTS nodes_select_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_insert_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_update_policy ON nodes");
        DB::statement("DROP POLICY IF EXISTS nodes_delete_policy ON nodes");

        // SELECT: From public books, user home pages, or owned books
        DB::statement("
            CREATE POLICY nodes_select_policy ON nodes
            FOR SELECT
            USING (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = nodes.book
                    AND (
                        library.visibility = 'public'
                        OR (library.raw_json->>'type' = 'user_home')
                        OR EXISTS (
                            SELECT 1 FROM users
                            WHERE users.name = library.creator
                            AND users.user_token::text = current_setting('app.current_token', true)
                        )
                        OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                )
            )
        ");

        // INSERT/UPDATE/DELETE: User home pages or owned books
        DB::statement("
            CREATE POLICY nodes_insert_policy ON nodes
            FOR INSERT
            WITH CHECK (
                EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = nodes.book
                    AND (
                        (library.raw_json->>'type' = 'user_home')
                        OR EXISTS (
                            SELECT 1 FROM users
                            WHERE users.name = library.creator
                            AND users.user_token::text = current_setting('app.current_token', true)
                        )
                        OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
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
                        (library.raw_json->>'type' = 'user_home')
                        OR EXISTS (
                            SELECT 1 FROM users
                            WHERE users.name = library.creator
                            AND users.user_token::text = current_setting('app.current_token', true)
                        )
                        OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
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
                        (library.raw_json->>'type' = 'user_home')
                        OR EXISTS (
                            SELECT 1 FROM users
                            WHERE users.name = library.creator
                            AND users.user_token::text = current_setting('app.current_token', true)
                        )
                        OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                )
            )
        ");

        // ==========================================
        // USERS TABLE - Require token match to read own record
        // This prevents SQL injection from reading user_token via username alone
        // ==========================================

        DB::statement("DROP POLICY IF EXISTS users_select_policy ON users");
        DB::statement("DROP POLICY IF EXISTS users_update_policy ON users");

        DB::statement("
            CREATE POLICY users_select_policy ON users
            FOR SELECT
            USING (
                (name)::text = current_setting('app.current_user', true)
                AND (user_token IS NULL OR user_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY users_update_policy ON users
            FOR UPDATE
            USING (
                (name)::text = current_setting('app.current_user', true)
                AND (user_token IS NULL OR user_token::text = current_setting('app.current_token', true))
            )
        ");

        // ==========================================
        // FOOTNOTES & BIBLIOGRAPHY (same pattern as nodes)
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
                            OR EXISTS (
                                SELECT 1 FROM users
                                WHERE users.name = library.creator
                                AND users.user_token::text = current_setting('app.current_token', true)
                            )
                            OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
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
                            EXISTS (
                                SELECT 1 FROM users
                                WHERE users.name = library.creator
                                AND users.user_token::text = current_setting('app.current_token', true)
                            )
                            OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
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
                            EXISTS (
                                SELECT 1 FROM users
                                WHERE users.name = library.creator
                                AND users.user_token::text = current_setting('app.current_token', true)
                            )
                            OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
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
                            EXISTS (
                                SELECT 1 FROM users
                                WHERE users.name = library.creator
                                AND users.user_token::text = current_setting('app.current_token', true)
                            )
                            OR (library.creator IS NULL AND library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true))
                        )
                    )
                )
            ");
        }
    }

    public function down(): void
    {
        // Revert to previous token-only policies (from 2025_12_18_160000 migration)
        // This will restore the less secure version where creator_token is stored in tables

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
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY library_insert_policy ON library
            FOR INSERT
            WITH CHECK (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

        DB::statement("
            CREATE POLICY library_update_policy ON library
            FOR UPDATE
            USING (
                creator_token IS NOT NULL
                AND creator_token::text = current_setting('app.current_token', true)
            )
        ");

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

        // HYPERLIGHTS
        DB::statement("DROP POLICY IF EXISTS hyperlights_select_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_insert_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_update_policy ON hyperlights");
        DB::statement("DROP POLICY IF EXISTS hyperlights_delete_policy ON hyperlights");

        DB::statement("
            CREATE POLICY hyperlights_select_policy ON hyperlights
            FOR SELECT
            USING (
                EXISTS (SELECT 1 FROM library WHERE library.book = hyperlights.book AND library.visibility = 'public')
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hyperlights_insert_policy ON hyperlights
            FOR INSERT
            WITH CHECK (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
        ");

        DB::statement("
            CREATE POLICY hyperlights_update_policy ON hyperlights
            FOR UPDATE
            USING (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
        ");

        DB::statement("
            CREATE POLICY hyperlights_delete_policy ON hyperlights
            FOR DELETE
            USING (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
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
                EXISTS (SELECT 1 FROM library WHERE library.book = hypercites.book AND library.visibility = 'public')
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::statement("
            CREATE POLICY hypercites_insert_policy ON hypercites
            FOR INSERT
            WITH CHECK (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
        ");

        DB::statement("
            CREATE POLICY hypercites_update_policy ON hypercites
            FOR UPDATE
            USING (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
        ");

        DB::statement("
            CREATE POLICY hypercites_delete_policy ON hypercites
            FOR DELETE
            USING (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
        ");

        // NODES
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
                    AND (library.visibility = 'public' OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true)))
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

        // FOOTNOTES & BIBLIOGRAPHY
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
                        AND (library.visibility = 'public' OR (library.creator_token IS NOT NULL AND library.creator_token::text = current_setting('app.current_token', true)))
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
};
