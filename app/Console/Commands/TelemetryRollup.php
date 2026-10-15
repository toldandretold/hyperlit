<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * telemetry:rollup — de-identify old reading telemetry.
 *
 * Folds book_reads / page_views rows older than
 * config('telemetry.raw_retention_days') into the identity-free rollup tables
 * (one row per book/page per day, summed views) and deletes the raw rows.
 * Scheduled daily; also the mechanism behind the privacy page's "raw
 * telemetry is aggregated and de-identified after N days" promise.
 *
 * Counts stay honest because the one-row-per-reader-per-day dedup happened at
 * WRITE time (ON CONFLICT in PageViewController / ReadingTelemetryController)
 * — each raw row IS one reader-day, so summing them loses nothing but the
 * identity linkage. Readers that need all-time totals combine raw + rollup:
 * ReadStatsCounter (library.total_views) and Maintainer\StatsController.
 * The 30-day windows and the depth funnel read RAW rows only — their windows
 * sit inside the retention period, which is why retention has a floor.
 *
 * INSERT-aggregate and DELETE run in ONE transaction per table, so a crash
 * can neither double-count nor drop a day; re-running is a no-op for rows
 * already swept (they no longer exist to re-aggregate).
 *
 * Dry-run by default (house style — StorageReclaim/PurgeDeletedBookContent);
 * the scheduler passes --force. If both --force and --dry-run are given, the
 * safe one wins.
 */
class TelemetryRollup extends Command
{
    protected $signature = 'telemetry:rollup {--force : Actually roll up and delete} {--dry-run : Report what would be swept (default)}';

    protected $description = 'Aggregate identity-bearing telemetry rows older than the retention window into de-identified daily counts, then delete them';

    private const MIN_RETENTION_DAYS = 31;

    public function handle(): int
    {
        $days = (int) config('telemetry.raw_retention_days');
        if ($days < self::MIN_RETENTION_DAYS) {
            $this->error("telemetry.raw_retention_days={$days} is below the floor of ".self::MIN_RETENTION_DAYS
                .' — the 30-day stats windows read raw rows only and would silently undercount.');

            return self::FAILURE;
        }

        $dry = ! $this->option('force') || $this->option('dry-run');
        $admin = DB::connection('pgsql_admin');
        $cutoff = now()->subDays($days)->toDateString();

        $tables = [
            // [raw table, rollup table, key column, date column]
            ['book_reads', 'book_read_rollups', 'book', 'read_date'],
            ['page_views', 'page_view_rollups', 'page', 'view_date'],
        ];

        foreach ($tables as [$raw, $rollup, $key, $date]) {
            $pending = $admin->selectOne(
                "SELECT COUNT(*) AS n, COUNT(DISTINCT ({$key}, {$date})) AS days FROM {$raw} WHERE {$date} < ?",
                [$cutoff],
            );

            if ($dry) {
                $this->line("[dry-run] {$raw}: {$pending->n} rows older than {$cutoff} would fold into {$pending->days} {$rollup} rows.");

                continue;
            }

            $deleted = 0;
            $admin->transaction(function () use ($admin, $raw, $rollup, $key, $date, $cutoff, &$deleted) {
                $admin->statement(<<<SQL
                    INSERT INTO {$rollup} ({$key}, {$date}, views)
                    SELECT {$key}, {$date}, COUNT(*)
                    FROM {$raw}
                    WHERE {$date} < ?
                    GROUP BY {$key}, {$date}
                    ON CONFLICT ({$key}, {$date})
                    DO UPDATE SET views = {$rollup}.views + EXCLUDED.views
                SQL, [$cutoff]);

                $deleted = $admin->table($raw)->where($date, '<', $cutoff)->delete();
            });

            $this->info("{$raw}: {$deleted} identity-bearing rows de-identified into {$rollup} (cutoff {$cutoff}).");
            if ($deleted > 0) {
                Log::info('telemetry:rollup swept', ['table' => $raw, 'rows' => $deleted, 'cutoff' => $cutoff]);
            }
        }

        if ($dry) {
            $this->line('Nothing changed. Run with --force to sweep.');
        }

        return self::SUCCESS;
    }
}
