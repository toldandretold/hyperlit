<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Models\User;
use App\Http\Controllers\UserHomeServerController;
use Illuminate\Support\Facades\DB;

class RegenerateUserHomePages extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'users:regenerate-home-pages';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Regenerate all user home pages with the new incremental logic.';

    /**
     * Execute the console command.
     */
    public function handle()
    {
        $this->info('Starting regeneration of all user home pages...');

        $users = User::all();
        $controller = new UserHomeServerController();

        foreach ($users as $user) {
            $username = $user->name;
            $this->line("Processing user: {$username}");

            // Regenerate the user's home page book
            $result = $controller->generateUserHomeBook($username);

            if ($result['success']) {
                $this->info("  -> Successfully regenerated page for {$username}. Chunks created: " . ($result['count'] ?? 'N/A'));
            } else {
                $this->error("  -> Failed to regenerate page for {$username}. Message: " . ($result['message'] ?? 'Unknown error'));
            }
        }

        $this->info('All user home pages have been regenerated.');
        return 0;
    }
}
