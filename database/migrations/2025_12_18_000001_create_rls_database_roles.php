<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create restricted application role and grant permissions.
     *
     * IMPORTANT: This migration must be run with admin/superuser privileges.
     * Run: php artisan migrate --database=pgsql_admin
     *
     * The application role (hyperlit_app) has limited permissions:
     * - Can SELECT, INSERT, UPDATE, DELETE on data tables
     * - Cannot create/drop tables, roles, or modify schema
     * - Subject to Row Level Security policies
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');
        $appPassword = env('DB_PASSWORD', 'change_me_in_production');
        $database = env('DB_DATABASE', 'hyperlit');

        // Create the application role if it doesn't exist
        DB::statement("
            DO \$\$
            BEGIN
                IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{$appUser}') THEN
                    CREATE ROLE {$appUser} WITH LOGIN PASSWORD '{$appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
                END IF;
            END
            \$\$;
        ");

        // Grant connection privilege
        DB::statement("GRANT CONNECT ON DATABASE \"{$database}\" TO {$appUser}");

        // Grant usage on schema
        DB::statement("GRANT USAGE ON SCHEMA public TO {$appUser}");

        // Data tables - full CRUD access (subject to RLS)
        $dataTables = [
            'library',
            'hyperlights',
            'hypercites',
            'nodes',
            'footnotes',
            'bibliography',
            'anonymous_sessions',
            'users',
            'sessions',
            'personal_access_tokens',
        ];

        foreach ($dataTables as $table) {
            DB::statement("GRANT SELECT, INSERT, UPDATE, DELETE ON public.{$table} TO {$appUser}");
        }

        // System tables - read-only or limited access
        $systemTables = [
            'migrations' => 'SELECT, INSERT',  // Laravel needs to record migrations
            'cache' => 'SELECT, INSERT, UPDATE, DELETE',
            'cache_locks' => 'SELECT, INSERT, UPDATE, DELETE',
            'jobs' => 'SELECT, INSERT, UPDATE, DELETE',
            'job_batches' => 'SELECT, INSERT, UPDATE, DELETE',
            'failed_jobs' => 'SELECT, INSERT, UPDATE, DELETE',
            'password_reset_tokens' => 'SELECT, INSERT, UPDATE, DELETE',
        ];

        foreach ($systemTables as $table => $permissions) {
            DB::statement("GRANT {$permissions} ON public.{$table} TO {$appUser}");
        }

        // Grant usage on all sequences (for auto-increment/serial columns)
        DB::statement("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {$appUser}");

        // Set default privileges for future tables created by admin
        DB::statement("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {$appUser}");
        DB::statement("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {$appUser}");
    }

    public function down(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Revoke all privileges
        DB::statement("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {$appUser}");
        DB::statement("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {$appUser}");
        DB::statement("REVOKE USAGE ON SCHEMA public FROM {$appUser}");

        // Remove default privileges
        DB::statement("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {$appUser}");
        DB::statement("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM {$appUser}");

        // Note: We don't DROP the role automatically - manual cleanup if needed:
        // DROP ROLE IF EXISTS hyperlit_app;
    }
};
