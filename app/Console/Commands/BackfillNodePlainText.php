<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Models\PgNodeChunk;

/**
 * Backfill plainText column for nodes
 *
 * PURPOSE:
 * Generates plainText from content for all nodes that are missing it.
 * This is needed for full-text search indexing.
 *
 * WHY THIS IS NEEDED:
 * - The plainText column was not always populated historically
 * - PostgreSQL full-text search (tsvector) needs plainText for accurate searching
 * - HTML content in 'content' column needs to be stripped to plain text
 *
 * USAGE:
 * php artisan nodes:backfill-plaintext              # Backfill all missing
 * php artisan nodes:backfill-plaintext {book}       # Backfill specific book
 * php artisan nodes:backfill-plaintext --dry-run    # Preview changes
 * php artisan nodes:backfill-plaintext --force      # Force regenerate all
 *
 * EXAMPLE:
 * php artisan nodes:backfill-plaintext book_1760156814805 --dry-run
 */
class BackfillNodePlainText extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'nodes:backfill-plaintext
                            {book? : Optional book ID to target}
                            {--dry-run : Preview without making changes}
                            {--force : Regenerate plainText even if already set}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Generate plainText from content for nodes that are missing it';

    /**
     * Batch size for processing
     */
    private const BATCH_SIZE = 1000;

    /**
     * Execute the console command.
     */
    public function handle()
    {
        $book = $this->argument('book');
        $dryRun = $this->option('dry-run');
        $force = $this->option('force');

        if ($dryRun) {
            $this->info('DRY RUN MODE - No changes will be made');
        }

        // Build query
        $query = PgNodeChunk::query()
            ->whereNotNull('content')
            ->where('content', '!=', '');

        if (!$force) {
            // Only target nodes with empty/null plainText
            $query->where(function ($q) {
                $q->whereNull('plainText')
                  ->orWhere('plainText', '');
            });
        }

        if ($book) {
            $query->where('book', $book);
            $this->info("Targeting book: {$book}");
        } else {
            $this->info("Targeting ALL books");
        }

        $totalCount = $query->count();

        if ($totalCount === 0) {
            $this->info('No nodes need plainText backfilling!');
            return 0;
        }

        $this->info("Found {$totalCount} nodes to process");

        if ($dryRun) {
            $this->newLine();
            $this->info('Sample of affected nodes:');
            $sample = $query->take(5)->get();

            foreach ($sample as $node) {
                $contentLength = strlen($node->content ?? '');
                $plainTextLength = strlen($node->plainText ?? '');
                $this->line("  Book: {$node->book} | Line: {$node->startLine} | Content: {$contentLength} chars | PlainText: {$plainTextLength} chars");
            }

            if ($totalCount > 5) {
                $this->line("  ... and " . ($totalCount - 5) . " more");
            }

            $this->newLine();
            $this->warn('To actually backfill, run without --dry-run flag');
            return 0;
        }

        // Confirm before proceeding
        if (!$this->confirm("Process {$totalCount} nodes?", true)) {
            $this->info('Cancelled');
            return 1;
        }

        $this->info('Backfilling plainText...');
        $bar = $this->output->createProgressBar($totalCount);
        $bar->start();

        $processedCount = 0;
        $errorCount = 0;

        // Process in batches
        $query->chunkById(self::BATCH_SIZE, function ($nodes) use (&$processedCount, &$errorCount, $bar) {
            foreach ($nodes as $node) {
                try {
                    // Generate plainText by stripping HTML tags
                    $plainText = strip_tags($node->content);

                    // Update directly to avoid triggering model events (which would be redundant)
                    PgNodeChunk::where('id', $node->id)->update([
                        'plainText' => $plainText
                    ]);

                    $processedCount++;
                } catch (\Exception $e) {
                    $errorCount++;
                    $this->error("\nError processing node {$node->book}:{$node->startLine} - {$e->getMessage()}");
                }

                $bar->advance();
            }
        });

        $bar->finish();
        $this->newLine(2);

        $this->info("Processed {$processedCount} nodes");

        if ($errorCount > 0) {
            $this->warn("{$errorCount} errors occurred");
        }

        $this->newLine();
        $this->info('Backfill complete! The tsvector search index will be updated automatically.');

        return 0;
    }
}
