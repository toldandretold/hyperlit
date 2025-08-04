<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use App\Http\Controllers\DbLibraryController; // Or move the methods

class UpdateLibraryStatsJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct() {}

    public function handle()
    {
        // Instantiate your controller or move the logic to a dedicated service class
        $controller = new DbLibraryController();
        // You can call a public method on the controller or, better yet,
        // refactor the 'executeChainedOperations' logic into a reusable service class.
        $controller->updateAllLibraryStats(); // Assuming this now contains the core logic
    }
}
