<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // SECURITY DEFINER function to read sessions without RLS restrictions.
        // Needed because StartSession reads the session BEFORE SetDatabaseSessionContext
        // can set app.session_id (chicken-and-egg: session needed to know user, user needed for RLS).
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION session_read(p_id text)
            RETURNS TABLE(id varchar, user_id bigint, ip_address varchar, user_agent text, payload text, last_activity integer)
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, user_id, ip_address, user_agent, payload, last_activity
                FROM sessions WHERE id = p_id LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        DB::connection('pgsql_admin')->statement("REVOKE EXECUTE ON FUNCTION session_read(text) FROM PUBLIC");
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION session_read(text) TO {$appUser}");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP FUNCTION IF EXISTS session_read(text)");
    }
};
