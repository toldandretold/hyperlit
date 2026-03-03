<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Harden SECURITY DEFINER functions against SQL injection abuse.
     *
     * Fix 1: Lock down password_reset_tokens with RLS, replace auth_update_password
     *         with atomic auth_create_password_reset_token + auth_execute_password_reset.
     * Fix 2: Drop legacy auth_lookup_user (leaks password hashes).
     * Fix 3: Replace check_book_visibility to return is_owner instead of creator_token.
     * Fix 4: Add missing REVOKE PUBLIC on auth_lookup_user_by_id.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // =============================================
        // FIX 1: Atomic password reset
        // =============================================

        // Enable RLS on password_reset_tokens — no policies = deny all for hyperlit_app
        DB::connection('pgsql_admin')->statement('ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY');
        DB::connection('pgsql_admin')->statement('ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY');

        // Create token insertion function (replaces direct DB::table() insert)
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION auth_create_password_reset_token(p_email text, p_token_hash text)
            RETURNS boolean
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            BEGIN
                DELETE FROM password_reset_tokens WHERE email = p_email;
                INSERT INTO password_reset_tokens (email, token, created_at)
                VALUES (p_email, p_token_hash, now());
                RETURN true;
            END;
            \$\$
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_create_password_reset_token(text, text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_create_password_reset_token(text, text) TO {$appUser}");

        // Atomic password reset function — requires plain token (only in victim's email)
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION auth_execute_password_reset(
                p_email text,
                p_plain_token text,
                p_new_password text,
                p_new_remember_token text
            )
            RETURNS boolean
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                v_stored_hash text;
                v_created_at  timestamptz;
            BEGIN
                -- Look up stored token
                SELECT token, created_at INTO v_stored_hash, v_created_at
                FROM password_reset_tokens
                WHERE email = p_email
                LIMIT 1;

                -- No token found
                IF v_stored_hash IS NULL THEN
                    RETURN false;
                END IF;

                -- Check 60-minute expiry
                IF v_created_at < (now() - interval '60 minutes') THEN
                    DELETE FROM password_reset_tokens WHERE email = p_email;
                    RETURN false;
                END IF;

                -- Verify token: SHA-256 hash of plain token must match stored hash
                IF encode(sha256(p_plain_token::bytea), 'hex') <> v_stored_hash THEN
                    RETURN false;
                END IF;

                -- Update password
                UPDATE users
                SET password = p_new_password,
                    remember_token = p_new_remember_token,
                    updated_at = now()
                WHERE email = p_email;

                -- Delete used token
                DELETE FROM password_reset_tokens WHERE email = p_email;

                RETURN true;
            END;
            \$\$
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_execute_password_reset(text, text, text, text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_execute_password_reset(text, text, text, text) TO {$appUser}");

        // Drop the dangerous auth_update_password function
        DB::connection('pgsql_admin')->statement('DROP FUNCTION IF EXISTS auth_update_password(bigint, text, text)');

        // =============================================
        // FIX 2: Drop legacy auth_lookup_user
        // =============================================

        DB::connection('pgsql_admin')->statement('DROP FUNCTION IF EXISTS auth_lookup_user(text)');

        // =============================================
        // FIX 3: check_book_visibility returns is_owner instead of creator_token
        // =============================================

        DB::connection('pgsql_admin')->statement('DROP FUNCTION IF EXISTS check_book_visibility(text)');

        DB::connection('pgsql_admin')->statement("
            CREATE FUNCTION check_book_visibility(p_book_id text)
            RETURNS TABLE(book_exists boolean, visibility varchar, creator varchar, is_owner boolean)
            LANGUAGE sql
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT
                    true,
                    library.visibility,
                    library.creator,
                    (
                        (library.creator IS NOT NULL
                         AND library.creator = current_setting('app.current_user', true))
                        OR
                        (library.creator_token IS NOT NULL
                         AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                FROM library
                WHERE library.book = p_book_id
                LIMIT 1
            \$\$
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION check_book_visibility(text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION check_book_visibility(text) TO {$appUser}");

        // =============================================
        // FIX 4: Missing REVOKE PUBLIC on auth_lookup_user_by_id
        // =============================================

        DB::connection('pgsql_admin')->statement('REVOKE EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) FROM PUBLIC');
    }

    public function down(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Restore auth_update_password
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION auth_update_password(p_id bigint, p_password text, p_remember_token text)
            RETURNS boolean
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                UPDATE users SET password = p_password, remember_token = p_remember_token, updated_at = now()
                WHERE id = p_id;
                SELECT true;
            \$\$
            LANGUAGE SQL;
        ");
        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_update_password(bigint, text, text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_update_password(bigint, text, text) TO {$appUser}");

        // Drop new password reset functions
        DB::connection('pgsql_admin')->statement('DROP FUNCTION IF EXISTS auth_create_password_reset_token(text, text)');
        DB::connection('pgsql_admin')->statement('DROP FUNCTION IF EXISTS auth_execute_password_reset(text, text, text, text)');

        // Remove RLS from password_reset_tokens
        DB::connection('pgsql_admin')->statement('ALTER TABLE password_reset_tokens DISABLE ROW LEVEL SECURITY');

        // Restore auth_lookup_user
        DB::connection('pgsql_admin')->statement("
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
        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_lookup_user(text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_lookup_user(text) TO {$appUser}");

        // Restore check_book_visibility with creator_token
        DB::connection('pgsql_admin')->statement('DROP FUNCTION IF EXISTS check_book_visibility(text)');
        DB::connection('pgsql_admin')->statement("
            CREATE FUNCTION check_book_visibility(p_book_id text)
            RETURNS TABLE(book_exists boolean, visibility varchar, creator varchar, creator_token uuid)
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT
                    true as book_exists,
                    library.visibility,
                    library.creator,
                    library.creator_token
                FROM library
                WHERE library.book = p_book_id
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");
        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION check_book_visibility(text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION check_book_visibility(text) TO {$appUser}");

        // Re-grant PUBLIC on auth_lookup_user_by_id (restore pre-fix state)
        DB::connection('pgsql_admin')->statement('GRANT EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) TO PUBLIC');
    }
};
