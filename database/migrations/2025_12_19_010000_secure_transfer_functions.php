<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Secure the transfer functions to prevent content theft.
     *
     * Previously, anyone could call transfer_anonymous_* functions with a stolen token
     * (obtained via check_book_visibility) to steal anonymous user content.
     *
     * Fix: Validate that the caller's session token (app.current_token) matches
     * the token being transferred. Only the rightful owner can transfer their content.
     *
     * IMPORTANT: Run with admin privileges: php artisan migrate --database=pgsql_admin
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Secure library transfer function
        DB::statement("
            CREATE OR REPLACE FUNCTION transfer_anonymous_library(p_token text, p_username text)
            RETURNS integer
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                updated_count integer;
                session_token text;
            BEGIN
                -- Get the caller's session token
                session_token := current_setting('app.current_token', true);

                -- Security check: caller must have the token they're trying to transfer
                -- This prevents stolen tokens from being used
                IF session_token IS NULL OR session_token = '' OR session_token != p_token THEN
                    RAISE EXCEPTION 'Unauthorized: session token does not match transfer token';
                END IF;

                UPDATE library
                SET creator = p_username,
                    creator_token = NULL  -- Clear token after transfer to logged-in user
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        // Secure hyperlights transfer function
        DB::statement("
            CREATE OR REPLACE FUNCTION transfer_anonymous_hyperlights(p_token text, p_username text)
            RETURNS integer
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                updated_count integer;
                session_token text;
            BEGIN
                -- Security check: caller must have the token they're trying to transfer
                session_token := current_setting('app.current_token', true);

                IF session_token IS NULL OR session_token = '' OR session_token != p_token THEN
                    RAISE EXCEPTION 'Unauthorized: session token does not match transfer token';
                END IF;

                UPDATE hyperlights
                SET creator = p_username,
                    creator_token = NULL  -- Clear token after transfer
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        // Secure hypercites transfer function
        DB::statement("
            CREATE OR REPLACE FUNCTION transfer_anonymous_hypercites(p_token text, p_username text)
            RETURNS integer
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                updated_count integer;
                session_token text;
            BEGIN
                -- Security check: caller must have the token they're trying to transfer
                session_token := current_setting('app.current_token', true);

                IF session_token IS NULL OR session_token = '' OR session_token != p_token THEN
                    RAISE EXCEPTION 'Unauthorized: session token does not match transfer token';
                END IF;

                UPDATE hypercites
                SET creator = p_username,
                    creator_token = NULL  -- Clear token after transfer
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        // Re-apply grants
        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_library(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_library(text, text) TO {$appUser}");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_hyperlights(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_hyperlights(text, text) TO {$appUser}");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_hypercites(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_hypercites(text, text) TO {$appUser}");
    }

    public function down(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Restore original (insecure) versions
        DB::statement("
            CREATE OR REPLACE FUNCTION transfer_anonymous_library(p_token text, p_username text)
            RETURNS integer
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                updated_count integer;
            BEGIN
                UPDATE library
                SET creator = p_username
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        DB::statement("
            CREATE OR REPLACE FUNCTION transfer_anonymous_hyperlights(p_token text, p_username text)
            RETURNS integer
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                updated_count integer;
            BEGIN
                UPDATE hyperlights
                SET creator = p_username
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        DB::statement("
            CREATE OR REPLACE FUNCTION transfer_anonymous_hypercites(p_token text, p_username text)
            RETURNS integer
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                updated_count integer;
            BEGIN
                UPDATE hypercites
                SET creator = p_username
                WHERE creator_token = p_token::uuid
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_library(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_library(text, text) TO {$appUser}");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_hyperlights(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_hyperlights(text, text) TO {$appUser}");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_hypercites(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_hypercites(text, text) TO {$appUser}");
    }
};
