<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Secure auth functions by not returning sensitive data.
     * 
     * auth_lookup_user_by_id no longer returns email or user_token.
     * This prevents SQL injection attacks from extracting user data.
     * 
     * user_token is now fetched via admin connection in PHP middleware.
     */
    public function up(): void
    {
        // Drop and recreate with reduced return columns
        DB::statement('DROP FUNCTION IF EXISTS auth_lookup_user_by_id(bigint)');
        
        DB::statement("
            CREATE FUNCTION auth_lookup_user_by_id(p_id bigint)
            RETURNS TABLE(id bigint, name character varying, password character varying, remember_token character varying, created_at timestamp without time zone, updated_at timestamp without time zone)
            LANGUAGE sql
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, name, password, remember_token, created_at, updated_at
                FROM users
                WHERE id = p_id
                LIMIT 1
            \$\$
        ");
        
        DB::statement('GRANT EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) TO hyperlit_app');
    }

    public function down(): void
    {
        // Restore original function with all columns
        DB::statement('DROP FUNCTION IF EXISTS auth_lookup_user_by_id(bigint)');
        
        DB::statement("
            CREATE FUNCTION auth_lookup_user_by_id(p_id bigint)
            RETURNS TABLE(id bigint, name character varying, email character varying, email_verified_at timestamp without time zone, password character varying, remember_token character varying, user_token uuid, created_at timestamp without time zone, updated_at timestamp without time zone)
            LANGUAGE sql
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, name, email, email_verified_at, password, remember_token, user_token, created_at, updated_at
                FROM users
                WHERE id = p_id
                LIMIT 1
            \$\$
        ");
        
        DB::statement('GRANT EXECUTE ON FUNCTION auth_lookup_user_by_id(bigint) TO hyperlit_app');
    }
};
