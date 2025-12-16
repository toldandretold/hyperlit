<?php

namespace App\Console;

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Console\Kernel as ConsoleKernel;

class Kernel extends ConsoleKernel
{
    /**
     * Define the application's command schedule.
     */
    protected function schedule(Schedule $schedule): void
    {
        // Update homepage rankings every 15 minutes
        $schedule->job(\App\Jobs\UpdateHomepageJob::class)
                 ->everyFifteenMinutes()
                 ->withoutOverlapping()
                 ->onOneServer();

        // Cleanup anonymous sessions daily
        $schedule->command('cleanup:anonymous-sessions')
                 ->daily();

        // Cleanup old anonymous private books daily
        $schedule->job(\App\Jobs\DatabaseCleanupJob::class)
                 ->daily()
                 ->withoutOverlapping()
                 ->onOneServer();
    }

    /**
     * Register the commands for the application.
     */
    protected function commands(): void
    {
        $this->load(__DIR__.'/Commands');

        require base_path('routes/console.php');
    }
}