<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Http\Controllers\UserHomeServerController;
use Illuminate\Support\Facades\DB;

class RegenerateUserHomePages extends Command
{
    protected $signature = 'users:regenerate-home-pages';
    protected $description = 'Regenerate every user home book (public, private, all, account) via the canonical controller methods.';

    public function handle()
    {
        $this->info('Starting regeneration of all user home pages...');

        $users = DB::connection('pgsql_admin')->table('users')->get();
        $controller = app(UserHomeServerController::class);

        foreach ($users as $user) {
            $username = $user->name;
            $this->line("Processing user: {$username}");

            try {
                $controller->generateUserHomeBook($username, false, 'public');
                $controller->generateUserHomeBook($username, false, 'private');
                $controller->generateAllUserHomeBook($username);
                $controller->generateAccountBook($username);
                $this->info("  -> Successfully regenerated pages for {$username}");
            } catch (\Exception $e) {
                $this->error("  -> Failed to regenerate pages for {$username}: " . $e->getMessage());
            }
        }

        $this->info('All user home pages have been regenerated.');
        return 0;
    }
}
