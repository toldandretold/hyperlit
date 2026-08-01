<?php

namespace App\Console\Commands;

use App\Services\Storage\StorageScanner;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Measure what Hyperlit is storing and write a snapshot.
 *
 * Scheduled nightly (routes/console.php) and triggerable from
 * /maintainer/storage. Snapshots accumulate on purpose: quota policy needs
 * measured GROWTH, not one instantaneous number.
 *
 * Counterpart: storage:reclaim (acts on what this reports).
 */
class StorageScan extends Command
{
    protected $signature = 'storage:scan
        {--json : Print the summary as JSON instead of text}
        {--keep=90 : How many past snapshots to retain}';

    protected $description = 'Measure database + file storage and record a snapshot';

    public function handle(StorageScanner $scanner): int
    {
        $startedAt = now();
        $start = microtime(true);

        $result = $scanner->scan();
        $totals = $result['totals'];
        $durationMs = (int) round((microtime(true) - $start) * 1000);

        $scanId = DB::table('storage_scans')->insertGetId([
            'started_at' => $startedAt,
            'finished_at' => now(),
            'duration_ms' => $durationMs,
            'total_bytes' => $totals['total_bytes'],
            'db_bytes' => $totals['db_bytes'],
            'file_bytes' => $totals['file_bytes'],
            'orphan_bytes' => $totals['orphan_bytes'],
            'disk_free_bytes' => $totals['disk_free_bytes'],
            'disk_total_bytes' => $totals['disk_total_bytes'],
            'notes' => json_encode([
                'images_tracked_bytes' => $totals['images_tracked_bytes'],
                'audio_tracked_bytes' => $totals['audio_tracked_bytes'],
            ]),
        ]);

        foreach (array_chunk($result['items'], 500) as $chunk) {
            DB::table('storage_scan_items')->insert(array_map(
                fn ($item) => $item + ['scan_id' => $scanId],
                $chunk,
            ));
        }

        $this->prune((int) $this->option('keep'));

        if ($this->option('json')) {
            $this->line(json_encode(['scan_id' => $scanId] + $totals, JSON_PRETTY_PRINT));

            return self::SUCCESS;
        }

        $this->report($scanId, $totals, $result['items'], $durationMs);

        return self::SUCCESS;
    }

    /** @param array<int, array<string, mixed>> $items */
    private function report(int $scanId, array $totals, array $items, int $durationMs): void
    {
        $byCategory = [];
        foreach ($items as $item) {
            $byCategory[$item['category']] ??= ['bytes' => 0, 'files' => 0];
            $byCategory[$item['category']]['bytes'] += $item['bytes'];
            $byCategory[$item['category']]['files'] += $item['file_count'];
        }
        arsort($byCategory);

        $this->info("Scan #{$scanId} — " . $this->human($totals['total_bytes']) . " total ({$durationMs}ms)");
        $this->newLine();

        foreach ($byCategory as $category => $agg) {
            $this->line(sprintf(
                '  %-15s %10s  %s',
                $category,
                $this->human($agg['bytes']),
                $category === StorageScanner::DATABASE
                    ? number_format($agg['files']) . ' rows (approx)'
                    : number_format($agg['files']) . ' files',
            ));
        }

        $this->newLine();
        $this->line('  database ....... ' . $this->human($totals['db_bytes']) . '  (managed cluster in prod — NOT droplet disk)');
        $this->line('  files .......... ' . $this->human($totals['file_bytes']));

        if ($totals['orphan_bytes'] > 0) {
            $this->newLine();
            $this->warn('  orphaned ....... ' . $this->human($totals['orphan_bytes']) . ' — files whose book has no library row');
            $this->line('  → php artisan storage:reclaim --dry-run');
        }

        // Bytes on disk that no book_images/book_audio row accounts for. Small
        // drift is normal (encryption padding); a large gap means untracked blobs.
        foreach (['images' => StorageScanner::IMAGES, 'audio' => StorageScanner::AUDIO] as $label => $category) {
            $disk = $byCategory[$category]['bytes'] ?? 0;
            $tracked = $totals["{$label}_tracked_bytes"];
            if ($disk > 0 && abs($disk - $tracked) > 0.05 * $disk) {
                $this->newLine();
                $this->warn(sprintf(
                    '  %s drift: %s on disk vs %s recorded in the DB',
                    $label,
                    $this->human($disk),
                    $this->human($tracked),
                ));
            }
        }

        if ($totals['disk_total_bytes']) {
            $used = $totals['disk_total_bytes'] - $totals['disk_free_bytes'];
            $this->newLine();
            $this->line(sprintf(
                '  droplet disk ... %s of %s used (%d%%)',
                $this->human($used),
                $this->human($totals['disk_total_bytes']),
                round($used / $totals['disk_total_bytes'] * 100),
            ));
        }
    }

    /** Keep the newest N snapshots; items cascade. */
    private function prune(int $keep): void
    {
        if ($keep < 1) {
            return;
        }

        $cutoff = DB::table('storage_scans')->orderByDesc('id')->skip($keep - 1)->take(1)->value('id');
        if ($cutoff) {
            DB::table('storage_scans')->where('id', '<', $cutoff)->delete();
        }
    }

    private function human(int|float|null $bytes): string
    {
        $bytes = (float) ($bytes ?? 0);
        foreach (['B', 'KB', 'MB', 'GB', 'TB'] as $unit) {
            if ($bytes < 1024 || $unit === 'TB') {
                return round($bytes, $unit === 'B' ? 0 : 1) . ' ' . $unit;
            }
            $bytes /= 1024;
        }

        return (string) $bytes;
    }
}
