<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Add `credits`, `debits`, `preferences` columns to auth_lookup_user_by_id return type.
     *
     * PostgreSQL cannot ALTER a function's return type, so we DROP + CREATE.
     * Uses pgsql_admin connection because the function is SECURITY DEFINER.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("DROP FUNCTION IF EXISTS auth_lookup_user_by_id(bigint)");

        DB::connection('pgsql_admin')->statement("
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
                updated_at timestamp,
                status varchar,
                credits numeric(12,4),
                debits numeric(12,4),
                preferences jsonb
            )
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, name, email, email_verified_at, password, remember_token, user_token, created_at, updated_at, status, credits, debits, preferences
                FROM users
                WHERE id = p_id
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) TO {$appUser}");
    }

    /**
     * Revert to the function with status only (without credits, debits, preferences).
     */
    public function down(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("DROP FUNCTION IF EXISTS auth_lookup_user_by_id(bigint)");

        DB::connection('pgsql_admin')->statement("
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
                updated_at timestamp,
                status varchar
            )
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, name, email, email_verified_at, password, remember_token, user_token, created_at, updated_at, status
                FROM users
                WHERE id = p_id
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) TO {$appUser}");
    }
};
