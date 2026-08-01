<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote')->hourly();

// Update homepage rankings every 15 minutes
Schedule::job(\App\Jobs\UpdateHomepageJob::class)
    ->everyFifteenMinutes()
    ->withoutOverlapping()
    ->onOneServer();

// Cleanup anonymous sessions daily
Schedule::command('cleanup:anonymous-sessions')
    ->daily();

// Give back credit holds whose job was killed without releasing them (a
// reservation increments users.debits for real, so a leaked hold is money).
Schedule::command('billing:reap-reservations')
    ->hourly()
    ->withoutOverlapping()
    ->onOneServer();

// Cleanup old anonymous private books daily
Schedule::job(\App\Jobs\DatabaseCleanupJob::class)
    ->daily()
    ->withoutOverlapping()
    ->onOneServer();

// Generate daily statistics at 08:00 UTC
Schedule::job(\App\Jobs\DailyStatsJob::class)
    ->dailyAt('08:00')
    ->withoutOverlapping()
    ->onOneServer();

// Storage snapshot for /maintainer/storage. Runs inline (~2s over ~70k files,
// I/O bound) rather than on a queue, so it never sits behind a 15-min import.
// Snapshots accumulate: quota policy needs measured growth, not one number.
Schedule::command('storage:scan')
    ->dailyAt('03:30')
    ->withoutOverlapping()
    ->onOneServer();
