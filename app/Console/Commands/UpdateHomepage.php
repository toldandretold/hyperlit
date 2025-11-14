<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Http\Controllers\HomePageServerController;

/**
 * Update Homepage Rankings
 *
 * PURPOSE:
 * Regenerates the homepage ranking books (most-recent, most-connected, most-lit)
 * and clears the cache to show fresh data immediately.
 *
 * USAGE:
 * php artisan homepage:update
 *
 * WHAT IT DOES:
 * 1. Calls HomePageServerController to regenerate ranking books
 * 2. Clears the 15-minute cache
 * 3. Shows count of books processed
 */
class UpdateHomepage extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'homepage:update';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Regenerate homepage ranking books (most-recent, most-connected, most-lit)';

    /**
     * Execute the console command.
     */
    public function handle()
    {
        $this->info('🏠 Updating homepage rankings...');

        $controller = new HomePageServerController();
        $response = $controller->updateHomePageBooks(request(), true);

        $data = $response->getData(true);

        if ($data['success']) {
            $this->info("✅ Successfully updated homepage");
            $this->line("   Books processed: {$data['books_processed']}");
            $this->line("   Timestamp: {$data['timestamp']}");
        } else {
            $this->error('❌ Failed to update homepage');
        }

        return 0;
    }
}
