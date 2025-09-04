<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;
use App\Http\Controllers\HomePageServerController;
use Illuminate\Http\Request;

class UpdateHomepageJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct()
    {
        //
    }

    public function handle(): void
    {
        try {
            Log::info('Starting scheduled homepage update');
            
            $controller = new HomePageServerController();
            $response = $controller->updateHomePageBooks(new Request(), true); // Force update
            
            $data = $response->getData(true);
            if ($data['success']) {
                Log::info('Homepage update completed successfully', [
                    'books_processed' => $data['books_processed']
                ]);
            } else {
                Log::error('Homepage update failed', ['response' => $data]);
            }
            
        } catch (\Exception $e) {
            Log::error('Homepage update job failed', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            throw $e;
        }
    }
}