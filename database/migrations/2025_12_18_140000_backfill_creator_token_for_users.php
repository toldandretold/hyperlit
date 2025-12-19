<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Backfill creator_token for content created by logged-in users.
     *
     * Previously, logged-in users had creator_token = NULL, relying only on
     * the public username for RLS. This migration links their content to their
     * secret user_token UUID, making RLS equally secure for both anonymous
     * and authenticated users.
     *
     * IMPORTANT: This migration must be run with admin/superuser privileges
     * AND after the add_user_token_to_users migration has been run.
     * Run: php artisan migrate --database=pgsql_admin
     */
    public function up(): void
    {
        // Backfill library records
        DB::statement("
            UPDATE library
            SET creator_token = users.user_token
            FROM users
            WHERE library.creator = users.name
              AND library.creator_token IS NULL
        ");

        // Backfill hyperlights records
        DB::statement("
            UPDATE hyperlights
            SET creator_token = users.user_token
            FROM users
            WHERE hyperlights.creator = users.name
              AND hyperlights.creator_token IS NULL
        ");

        // Backfill hypercites records
        DB::statement("
            UPDATE hypercites
            SET creator_token = users.user_token
            FROM users
            WHERE hypercites.creator = users.name
              AND hypercites.creator_token IS NULL
        ");
    }

    public function down(): void
    {
        // Revert: Set creator_token back to NULL for logged-in user content
        // Only affects records where creator matches a user (not anonymous content)
        DB::statement("
            UPDATE library
            SET creator_token = NULL
            FROM users
            WHERE library.creator = users.name
              AND library.creator_token = users.user_token
        ");

        DB::statement("
            UPDATE hyperlights
            SET creator_token = NULL
            FROM users
            WHERE hyperlights.creator = users.name
              AND hyperlights.creator_token = users.user_token
        ");

        DB::statement("
            UPDATE hypercites
            SET creator_token = NULL
            FROM users
            WHERE hypercites.creator = users.name
              AND hypercites.creator_token = users.user_token
        ");
    }
};
