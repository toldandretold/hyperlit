<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Add user_token UUID column to users table.
     *
     * This provides a secret identifier for RLS, making logged-in users
     * as secure as anonymous users (who already use secret UUIDs).
     *
     * Without this, an attacker with SQL injection could impersonate any user
     * just by knowing their public username. With user_token, they'd need
     * to know a 128-bit UUID.
     *
     * IMPORTANT: This migration must be run with admin/superuser privileges.
     * Run: php artisan migrate --database=pgsql_admin
     */
    public function up(): void
    {
        // Step 1: Add nullable user_token column
        DB::statement("ALTER TABLE users ADD COLUMN IF NOT EXISTS user_token UUID");

        // Step 2: Backfill existing users with UUIDs
        DB::statement("UPDATE users SET user_token = gen_random_uuid() WHERE user_token IS NULL");

        // Step 3: Make column NOT NULL and add unique constraint
        DB::statement("ALTER TABLE users ALTER COLUMN user_token SET NOT NULL");
        DB::statement("ALTER TABLE users ADD CONSTRAINT users_user_token_unique UNIQUE (user_token)");

        // Step 4: Create index for fast lookups
        DB::statement("CREATE INDEX IF NOT EXISTS users_user_token_idx ON users (user_token)");
    }

    public function down(): void
    {
        DB::statement("DROP INDEX IF EXISTS users_user_token_idx");
        DB::statement("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_token_unique");
        DB::statement("ALTER TABLE users DROP COLUMN IF EXISTS user_token");
    }
};
