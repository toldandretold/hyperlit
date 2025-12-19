<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create a SECURITY DEFINER function to check book visibility.
     *
     * This function bypasses RLS to check if a book exists and its visibility status.
     * This allows the application to distinguish between:
     * - Book doesn't exist → 404
     * - Book exists but is private → 403 (triggers frontend private book handlers)
     * - Book exists and user has access → proceed with normal query
     *
     * IMPORTANT: This migration must be run with admin/superuser privileges.
     * Run: php artisan migrate --database=pgsql_admin
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Create SECURITY DEFINER function to check book visibility
        // This bypasses RLS to allow checking if a book exists and its visibility
        DB::statement("
            CREATE OR REPLACE FUNCTION check_book_visibility(p_book_id text)
            RETURNS TABLE(book_exists boolean, visibility varchar, creator varchar, creator_token uuid)
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT
                    true as book_exists,
                    library.visibility,
                    library.creator,
                    library.creator_token
                FROM library
                WHERE library.book = p_book_id
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        // Restrict who can call this function
        DB::statement("REVOKE EXECUTE ON FUNCTION check_book_visibility(text) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION check_book_visibility(text) TO {$appUser}");
    }

    public function down(): void
    {
        DB::statement("DROP FUNCTION IF EXISTS check_book_visibility(text)");
    }
};
