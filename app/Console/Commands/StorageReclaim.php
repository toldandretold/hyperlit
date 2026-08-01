<?php

namespace App\Console\Commands;

use App\Services\Storage\StorageScanner;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Delete the file trees of books that no longer exist.
 *
 * Nothing in the app removes a book's files (BookDeletionService deletes DB
 * rows only), so `resources/markdown/<book>/`, `storage/app/books/<book>/` and
 * the cache/legacy trees accumulate forever. This is the broom.
 *
 * It deletes user content irreversibly, so every guard is deliberate:
 *   - DRY RUN BY DEFAULT. Deletion needs --force, typed by a human.
 *   - Candidates are re-verified against `library` at delete time, never
 *     trusted from a snapshot that may be hours old.
 *   - A directory younger than --min-age-days is SKIPPED: an import writes its
 *     files before the library row exists, so a fresh orphan may be a book
 *     being created right now.
 *   - Paths must sit directly under one of the known roots. Anything else is
 *     refused, whatever the scan said.
 */
class StorageReclaim extends Command
{
    protected $signature = 'storage:reclaim
        {--force : Actually delete (default is a dry run)}
        {--dry-run : Explicit no-op — a dry run is already the default; wins over --force if both are given}
        {--min-age-days=7 : Skip directories modified more recently than this}
        {--category= : Limit to one category (documents|images|audio|cache|legacy_images)}';

    protected $description = 'Delete file trees belonging to books with no library row (dry run by default)';

    /**
     * The only roots a candidate may live directly under — from config, so the
     * environment switches the FOLDERS the same way it switches the database
     * (config/storage.php). Never hardcode a path here: that mismatch is how a
     * test once read the empty test database and deleted real files.
     */
    private function roots(): array
    {
        return StorageScanner::roots();
    }

    public function handle(StorageScanner $scanner): int
    {
        // --dry-run is redundant but people type it (the docs and the page both
        // print it), and erroring on it would be a papercut. If both are given,
        // the SAFE one wins — never delete on an ambiguous instruction.
        $force = (bool) $this->option('force') && ! $this->option('dry-run');
        $minAgeDays = max(0, (int) $this->option('min-age-days'));
        $onlyCategory = $this->option('category');

        $this->line($force
            ? '⚠ FORCE — matching directories will be DELETED'
            : 'Dry run — nothing will be deleted (pass --force to act)');
        $this->newLine();

        // Scan fresh rather than reading a snapshot: the whole point is that the
        // library table is the authority at THIS moment.
        $items = collect($scanner->scan()['items'])
            ->filter(fn ($i) => $i['is_orphan'] && $i['path'] !== null)
            ->when($onlyCategory, fn ($c) => $c->filter(fn ($i) => $i['category'] === $onlyCategory));

        // One directory can produce several items (documents split by extension).
        $dirs = [];
        foreach ($items as $item) {
            $dirs[$item['path']] ??= ['book' => $item['book'], 'category' => $item['category'], 'bytes' => 0, 'files' => 0];
            $dirs[$item['path']]['bytes'] += $item['bytes'];
            $dirs[$item['path']]['files'] += $item['file_count'];
        }
        uasort($dirs, fn ($a, $b) => $b['bytes'] <=> $a['bytes']);

        if ($dirs === []) {
            $this->info('✓ No orphaned directories.');

            return self::SUCCESS;
        }

        $deleted = $skipped = 0;
        $deletedBytes = $skippedBytes = 0;
        $cutoff = now()->subDays($minAgeDays)->getTimestamp();

        foreach ($dirs as $path => $meta) {
            $reason = $this->refuseReason($path, $meta['book'], $cutoff, $minAgeDays);

            if ($reason !== null) {
                $skipped++;
                $skippedBytes += $meta['bytes'];
                $this->line(sprintf('  SKIP  %-10s %s  (%s)', $this->human($meta['bytes']), $path, $reason));

                continue;
            }

            $this->line(sprintf('  %s  %-10s %s  [%s, %d files]',
                $force ? 'DEL ' : 'would', $this->human($meta['bytes']), $path, $meta['category'], $meta['files']));

            if ($force) {
                File::deleteDirectory($path);
            }
            $deleted++;
            $deletedBytes += $meta['bytes'];
        }

        $this->newLine();
        $this->info(sprintf(
            '%s %d directories, %s%s',
            $force ? 'Deleted' : 'Would delete',
            $deleted,
            $this->human($deletedBytes),
            $skipped > 0 ? sprintf('  (skipped %d, %s)', $skipped, $this->human($skippedBytes)) : '',
        ));

        if (! $force && $deleted > 0) {
            $this->newLine();
            $this->line('Re-run with --force to delete. There is no undo.');
        }

        return self::SUCCESS;
    }

    /**
     * Why this path must NOT be deleted, or null if it may be.
     *
     * Re-checks everything the scan claimed, because the scan is a snapshot and
     * this is a deletion.
     */
    private function refuseReason(string $path, ?string $book, int $cutoff, int $minAgeDays): ?string
    {
        if ($book === null || $book === '') {
            return 'no book id';
        }

        // Must live directly under a known root — never a path the scan invented.
        $real = realpath($path);
        $ok = false;
        foreach ($this->roots() as $root) {
            $realRoot = realpath($root);
            if ($realRoot && $real && str_starts_with($real, $realRoot . DIRECTORY_SEPARATOR)) {
                $ok = true;
                break;
            }
        }
        if (! $ok) {
            return 'outside the known storage roots';
        }

        // The authority, checked now: a row for the root book id OR any of its
        // sub-books means this content is live.
        $exists = DB::connection('pgsql_admin')->table('library')
            ->where('book', $book)
            ->orWhere('book', 'like', $book . '/%')
            ->exists();
        if ($exists) {
            return 'library row exists';
        }

        // An import writes files BEFORE its library row — a young directory may
        // be a book being created right now.
        $mtime = @filemtime($path);
        if ($mtime !== false && $mtime > $cutoff) {
            return "modified within {$minAgeDays}d";
        }

        return null;
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
