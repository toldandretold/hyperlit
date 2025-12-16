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

// Cleanup old anonymous private books daily
Schedule::job(\App\Jobs\DatabaseCleanupJob::class)
    ->daily()
    ->withoutOverlapping()
    ->onOneServer();
