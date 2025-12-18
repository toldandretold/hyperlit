<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create SECURITY DEFINER function to validate anonymous tokens.
     *
     * This is needed because when a user logs in and wants to transfer their
     * anonymous content, the RLS policy on anonymous_sessions blocks the
     * validation query (app.current_token is empty for logged-in users).
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::statement("
            CREATE OR REPLACE FUNCTION validate_anonymous_token(p_token text, p_expiry_days integer DEFAULT 90)
            RETURNS boolean
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            BEGIN
                RETURN EXISTS (
                    SELECT 1 FROM anonymous_sessions
                    WHERE token = p_token
                      AND created_at > (NOW() - (p_expiry_days || ' days')::interval)
                );
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        DB::statement("REVOKE EXECUTE ON FUNCTION validate_anonymous_token(text, integer) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION validate_anonymous_token(text, integer) TO {$appUser}");
    }

    public function down(): void
    {
        DB::statement("DROP FUNCTION IF EXISTS validate_anonymous_token(text, integer)");
    }
};
