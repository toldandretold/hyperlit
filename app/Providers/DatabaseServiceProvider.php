<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

class DatabaseServiceProvider extends ServiceProvider
{
    /**
     * Bootstrap database services.
     *
     * Switches to admin connection for migration and schema commands.
     * This ensures migrations run with full privileges (bypassing RLS)
     * while the application runs with restricted permissions.
     */
    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $command = $_SERVER['argv'][1] ?? '';

            // Commands that need admin/superuser access
            $adminCommands = [
                'migrate',
                'migrate:fresh',
                'migrate:install',
                'migrate:refresh',
                'migrate:reset',
                'migrate:rollback',
                'migrate:status',
                'db:seed',
                'db:wipe',
                'schema:dump',
            ];

            // Check if current command needs admin access
            foreach ($adminCommands as $adminCommand) {
                if (str_starts_with($command, $adminCommand)) {
                    // Switch to admin connection for schema operations
                    config(['database.default' => 'pgsql_admin']);
                    break;
                }
            }
        }
    }
}
