<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create SECURITY DEFINER functions to transfer anonymous content ownership.
     *
     * These bypass RLS to allow transferring content from anonymous token to
     * authenticated user. The catch-22 is:
     * - After login, app.current_user is set but app.current_token is empty
     * - Anonymous records have creator=NULL and creator_token=uuid
     * - RLS UPDATE requires creator match OR creator_token match
     * - Neither matches, so UPDATE is blocked
     *
     * These functions verify the token and perform the transfer safely.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Transfer library records from anonymous token to user
        DB::statement("
            CREATE OR REPLACE FUNCTION transfer_anonymous_library(p_token text, p_username text)
            RETURNS integer
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                updated_count integer;
            BEGIN
                -- Only transfer records that:
                -- 1. Have matching creator_token
                -- 2. Have no creator yet (NULL)
                UPDATE library
                SET creator = p_username
                WHERE creator_token = p_token
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        // Transfer hyperlights from anonymous token to user
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
                WHERE creator_token = p_token
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        // Transfer hypercites from anonymous token to user
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
                WHERE creator_token = p_token
                  AND creator IS NULL;

                GET DIAGNOSTICS updated_count = ROW_COUNT;
                RETURN updated_count;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        // Restrict access to app user only
        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_library(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_library(text, text) TO {$appUser}");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_hyperlights(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_hyperlights(text, text) TO {$appUser}");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_hypercites(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_hypercites(text, text) TO {$appUser}");
    }

    public function down(): void
    {
        DB::statement("DROP FUNCTION IF EXISTS transfer_anonymous_library(text, text)");
        DB::statement("DROP FUNCTION IF EXISTS transfer_anonymous_hyperlights(text, text)");
        DB::statement("DROP FUNCTION IF EXISTS transfer_anonymous_hypercites(text, text)");
    }
};
