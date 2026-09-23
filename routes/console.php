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

// Sweep stale import-failure upload backups daily. (Rescued from the deleted
// dead app/Console/Kernel.php — nothing ever bound that class in this Laravel
// 11 skeleton, so this sweep silently never ran.)
Schedule::command('uploads:clean-import-failures')
    ->daily();

// Give back credit holds whose job was killed without releasing them (a
// reservation increments users.debits for real, so a leaked hold is money).
Schedule::command('billing:reap-reservations')
    ->hourly()
    ->withoutOverlapping()
    ->onOneServer();

// Credit any paid-but-uncredited Stripe top-ups the webhook missed, and alert on
// stuck ones — so a paying user is never left waiting on Stripe's ~72h retry.
Schedule::command('billing:reconcile-stripe')
    ->everyFiveMinutes()
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

// Generated-book history sweep. The fixed ranking books AND generated library
// cards (node_id ending `_card` — user home/sorted/shelf feeds) are excluded at
// the versioning trigger, so the bulk churn never lands. This weekly sweep mops
// up what the trigger can't catch by column alone: account-ledger entry nodes,
// About-book nodes, and any legacy rows from before the trigger exclusions
// (identified by library.raw_json type — see PurgeSystemNodeHistory).
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

// Embedding reconciliation: converge to the EmbeddingEligibility definition —
// queue books with missing embeddings (write paths that forgot to dispatch,
// 3-strikes API failures, content edits that nulled a stale vector) and scrub
// strays on ineligible books. The dispatch side lands on the low-priority
// 'embeddings' queue, so even a huge post-import backlog never blocks imports.
Schedule::command('embeddings:reconcile')
    ->dailyAt('04:30')
    ->withoutOverlapping()
    ->onOneServer();
