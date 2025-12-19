<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create auth_lookup_user_by_id function for session restoration.
     *
     * This SECURITY DEFINER function allows the RlsUserProvider to restore
     * a user from session without RLS blocking the query. Returns all user
     * fields needed for authentication including the secret user_token for RLS.
     *
     * IMPORTANT: This migration must be run with admin/superuser privileges.
     * Run: php artisan migrate --database=pgsql_admin
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Drop existing function first - PostgreSQL can't change return type with CREATE OR REPLACE
        DB::statement("DROP FUNCTION IF EXISTS auth_lookup_user_by_id(bigint)");

        // Create auth_lookup_user_by_id for session restoration
        // Returns all user fields including user_token for RLS context
        DB::statement("
            CREATE FUNCTION auth_lookup_user_by_id(p_id bigint)
            RETURNS TABLE(
                id bigint,
                name varchar,
                email varchar,
                email_verified_at timestamp,
                password varchar,
                remember_token varchar,
                user_token uuid,
                created_at timestamp,
                updated_at timestamp
            )
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, name, email, email_verified_at, password, remember_token, user_token, created_at, updated_at
                FROM users
                WHERE id = p_id
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        // Restrict who can call the function
        DB::statement("REVOKE EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) TO {$appUser}");

        // Create lookup_user_by_name for public profile lookups
        // Only returns public fields - NOT sensitive data like email, password, or user_token
        DB::statement("
            CREATE OR REPLACE FUNCTION lookup_user_by_name(p_name text)
            RETURNS TABLE(
                id bigint,
                name varchar,
                created_at timestamp
            )
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, name, created_at
                FROM users
                WHERE name = p_name
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        // This function can be called by the app user
        DB::statement("REVOKE EXECUTE ON FUNCTION lookup_user_by_name(text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION lookup_user_by_name(text) TO {$appUser}");
    }

    public function down(): void
    {
        DB::statement("DROP FUNCTION IF EXISTS auth_lookup_user_by_id(bigint)");
        DB::statement("DROP FUNCTION IF EXISTS lookup_user_by_name(text)");
    }
};
