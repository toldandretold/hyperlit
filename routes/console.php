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

// Generated books (user home/account/shelf pages) are rebuilt by deleting all
// their nodes and re-inserting, so the versioning trigger archives a row per
// card every time. The trigger can't exclude them — their ids are per-user, and
// a trigger WHEN clause can't run a subquery — so the history is swept weekly
// instead. The fixed ranking books ARE excluded at the trigger, so this only
// mops up what still gets written.
Schedule::command('nodes:purge-system-history --force')
    ->weekly()
    ->sundays()
    ->at('04:00')
    ->withoutOverlapping()
    ->onOneServer();

// Storage snapshot for /maintainer/storage. Runs inline (~2s over ~70k files,
// I/O bound) rather than on a queue, so it never sits behind a 15-min import.
// Snapshots accumulate: quota policy needs measured growth, not one number.
Schedule::command('storage:scan')
    ->dailyAt('03:30')
    ->withoutOverlapping()
    ->onOneServer();
