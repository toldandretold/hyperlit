<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Verify a user's email address (only if email hasn't changed since link was sent)
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION auth_verify_user_email(p_id bigint, p_email text)
            RETURNS boolean
            SECURITY DEFINER
            SET search_path = public
            LANGUAGE plpgsql
            AS \$\$
            DECLARE
                rows_affected int;
            BEGIN
                UPDATE users
                SET email_verified_at = now(), updated_at = now()
                WHERE id = p_id AND email = p_email AND email_verified_at IS NULL;
                GET DIAGNOSTICS rows_affected = ROW_COUNT;
                RETURN rows_affected > 0;
            END;
            \$\$;
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_verify_user_email(bigint, text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_verify_user_email(bigint, text) TO {$appUser}");

        // Change a user's email and reset verification
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION auth_change_user_email(p_id bigint, p_new_email text)
            RETURNS boolean
            SECURITY DEFINER
            SET search_path = public
            LANGUAGE plpgsql
            AS \$\$
            DECLARE
                rows_affected int;
            BEGIN
                UPDATE users
                SET email = p_new_email, email_verified_at = NULL, updated_at = now()
                WHERE id = p_id;
                GET DIAGNOSTICS rows_affected = ROW_COUNT;
                RETURN rows_affected > 0;
            END;
            \$\$;
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_change_user_email(bigint, text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_change_user_email(bigint, text) TO {$appUser}");

    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP FUNCTION IF EXISTS auth_verify_user_email(bigint, text)");
        DB::connection('pgsql_admin')->statement("DROP FUNCTION IF EXISTS auth_change_user_email(bigint, text)");
    }
};
