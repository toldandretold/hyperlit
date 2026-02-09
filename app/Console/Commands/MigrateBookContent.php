<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use App\Services\BookMigrationService;

/**
 * Migrate node IDs and normalize footnotes for books
 *
 * PURPOSE:
 * Runs one-time migrations that were previously happening on every page load:
 * - Fills missing node_id fields (with sparse fill or full renumbering)
 * - Normalizes footnote HTML to canonical format
 * - Renumbers footnotes in document order
 *
 * WHY THIS IS NEEDED:
 * - These migrations were running on every getNodeChunks() call, adding latency
 * - Moving to a one-time command makes page loads faster
 * - Data should already be in correct format after running this once
 *
 * USAGE:
 * php artisan books:migrate-content              # Migrate all books
 * php artisan books:migrate-content {book}       # Migrate specific book
 * php artisan books:migrate-content --dry-run    # Preview changes
 * php artisan books:migrate-content --force      # Skip confirmation
 *
 * EXAMPLE:
 * php artisan books:migrate-content book_1760156814805 --dry-run
 */
class MigrateBookContent extends Command
{
    protected $signature = 'books:migrate-content
                            {book? : Optional book ID to target}
                            {--dry-run : Preview without making changes}
                            {--force : Skip confirmation prompt}';

    protected $description = 'Migrate node IDs and normalize footnotes for books (one-time migration)';

    public function handle(BookMigrationService $migrationService): int
    {
        $book = $this->argument('book');
        $dryRun = $this->option('dry-run');
        $force = $this->option('force');

        if ($dryRun) {
            $this->info('DRY RUN MODE - No changes will be made');
            $this->newLine();
        }

        // Get books to process (with timestamps for age reporting)
        if ($book) {
            $booksData = DB::table('library')
                ->where('book', $book)
                ->select('book', 'timestamp', 'created_at')
                ->get()
                ->keyBy('book');
            $books = collect([$book]);
            $this->info("Targeting book: {$book}");
        } else {
            $booksData = DB::table('library')
                ->where('visibility', '!=', 'deleted')
                ->select('book', 'timestamp', 'created_at')
                ->get()
                ->keyBy('book');
            $books = $booksData->keys();
            $this->info("Targeting ALL books ({$books->count()} total)");
        }

        if ($books->isEmpty()) {
            $this->warn('No books found to process');
            return 0;
        }

        // Confirm before proceeding (unless dry-run or force)
        if (!$dryRun && !$force) {
            if (!$this->confirm("Process {$books->count()} book(s)?", true)) {
                $this->info('Cancelled');
                return 1;
            }
        }

        $this->newLine();
        $bar = $this->output->createProgressBar($books->count());
        $bar->setFormat(' %current%/%max% [%bar%] %percent:3s%% | %message%');
        $bar->start();

        $totals = [
            'books_processed' => 0,
            'books_with_changes' => 0,
            'node_ids_filled' => 0,
            'footnotes_fixed' => 0,
            'errors' => 0,
        ];

        // Track books that need changes for age reporting
        $booksNeedingChanges = [];

        foreach ($books as $bookId) {
            $bar->setMessage("Processing: {$bookId}");

            try {
                // Run node ID migration
                $nodeIdStats = $migrationService->migrateNodeIds($bookId, $dryRun);

                // Run footnote migration
                $footnoteStats = $migrationService->migrateNodeFootnotes($bookId, $dryRun);

                $totals['books_processed']++;

                if ($nodeIdStats['chunks_updated'] > 0 || $footnoteStats['nodes_fixed'] > 0) {
                    $totals['books_with_changes']++;

                    // Track for age reporting
                    $booksNeedingChanges[] = [
                        'book_id' => $bookId,
                        'node_ids' => $nodeIdStats['chunks_updated'],
                        'footnotes' => $footnoteStats['nodes_fixed'],
                        'strategy' => $nodeIdStats['strategy'],
                        'timestamp' => $booksData[$bookId]->timestamp ?? null,
                        'created_at' => $booksData[$bookId]->created_at ?? null,
                    ];
                }

                $totals['node_ids_filled'] += $nodeIdStats['chunks_updated'];
                $totals['footnotes_fixed'] += $footnoteStats['nodes_fixed'];

            } catch (\Exception $e) {
                $totals['errors']++;
                $this->newLine();
                $this->error("Error processing {$bookId}: {$e->getMessage()}");
            }

            $bar->advance();
        }

        $bar->setMessage('Complete!');
        $bar->finish();
        $this->newLine(2);

        // Summary
        $this->info('Migration Summary:');
        $this->table(
            ['Metric', 'Count'],
            [
                ['Books processed', $totals['books_processed']],
                ['Books with changes', $totals['books_with_changes']],
                ['Node IDs filled/renumbered', $totals['node_ids_filled']],
                ['Footnotes normalized', $totals['footnotes_fixed']],
                ['Errors', $totals['errors']],
            ]
        );

        // Show books needing changes with their ages
        if (!empty($booksNeedingChanges)) {
            $this->newLine();
            $this->info('Books needing migration (sorted by age):');

            // Sort by timestamp (oldest first)
            usort($booksNeedingChanges, fn($a, $b) => ($a['timestamp'] ?? 0) <=> ($b['timestamp'] ?? 0));

            $rows = [];
            foreach ($booksNeedingChanges as $book) {
                $age = $this->formatAge($book['timestamp']);
                $issues = [];
                if ($book['node_ids'] > 0) {
                    $issues[] = "{$book['node_ids']} node IDs ({$book['strategy']})";
                }
                if ($book['footnotes'] > 0) {
                    $issues[] = "{$book['footnotes']} footnotes";
                }

                $rows[] = [
                    $book['book_id'],
                    $age,
                    implode(', ', $issues),
                ];
            }

            $this->table(['Book ID', 'Age', 'Issues'], $rows);

            // Show age distribution summary
            $this->newLine();
            $this->showAgeDistribution($booksNeedingChanges);
        }

        if ($dryRun) {
            $this->newLine();
            $this->warn('This was a dry run. Run without --dry-run to apply changes.');
        }

        return $totals['errors'] > 0 ? 1 : 0;
    }

    /**
     * Format a timestamp as human-readable age
     */
    private function formatAge(?int $timestamp): string
    {
        if (!$timestamp) {
            return 'Unknown';
        }

        // Timestamp is in milliseconds
        $created = \Carbon\Carbon::createFromTimestampMs($timestamp);
        $diff = $created->diffForHumans();

        return $diff . ' (' . $created->format('Y-m-d') . ')';
    }

    /**
     * Show age distribution of books needing changes
     */
    private function showAgeDistribution(array $books): void
    {
        $now = now();
        $buckets = [
            'Last 7 days' => 0,
            'Last 30 days' => 0,
            'Last 90 days' => 0,
            'Older than 90 days' => 0,
            'Unknown age' => 0,
        ];

        foreach ($books as $book) {
            if (!$book['timestamp']) {
                $buckets['Unknown age']++;
                continue;
            }

            $created = \Carbon\Carbon::createFromTimestampMs($book['timestamp']);
            $daysAgo = $created->diffInDays($now);

            if ($daysAgo <= 7) {
                $buckets['Last 7 days']++;
            } elseif ($daysAgo <= 30) {
                $buckets['Last 30 days']++;
            } elseif ($daysAgo <= 90) {
                $buckets['Last 90 days']++;
            } else {
                $buckets['Older than 90 days']++;
            }
        }

        $this->info('Age distribution:');
        foreach ($buckets as $label => $count) {
            if ($count > 0) {
                $this->line("  {$label}: {$count} book(s)");
            }
        }
    }
}
