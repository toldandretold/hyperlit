<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Fix the transfer functions to properly cast text to uuid.
     * The creator_token column is uuid type, but the function parameter is text.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Fix library transfer function - add ::uuid cast
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

        // Fix hyperlights transfer function - add ::uuid cast
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

        // Fix hypercites transfer function - add ::uuid cast
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

        // Re-apply grants (CREATE OR REPLACE may reset them)
        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_library(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_library(text, text) TO {$appUser}");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_hyperlights(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_hyperlights(text, text) TO {$appUser}");

        DB::statement("REVOKE EXECUTE ON FUNCTION transfer_anonymous_hypercites(text, text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION transfer_anonymous_hypercites(text, text) TO {$appUser}");
    }

    public function down(): void
    {
        // Nothing to rollback - original functions still work, just with type error
    }
};
