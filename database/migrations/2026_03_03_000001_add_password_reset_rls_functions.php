<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Narrow lookup: returns only id + email (no password hash, no tokens)
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION auth_lookup_user_by_email(p_email text)
            RETURNS TABLE(id bigint, email varchar)
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, email FROM users WHERE email = p_email LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION auth_lookup_user_by_email(text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION auth_lookup_user_by_email(text) TO {$appUser}");

        // Update password by id (accepts pre-hashed password from Laravel)
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
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP FUNCTION IF EXISTS auth_lookup_user_by_email(text)");
        DB::connection('pgsql_admin')->statement("DROP FUNCTION IF EXISTS auth_update_password(bigint, text, text)");
    }
};
