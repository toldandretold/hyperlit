<?php

namespace App\Console\Commands;

use App\Jobs\QueueBookEmbeddings;
use App\Models\PgNode;
use Illuminate\Console\Command;

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
                            {--force : Regenerate plainText even if already set}
                            {--no-embed : Skip re-queuing embeddings for affected books}';

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
        $noEmbed = $this->option('no-embed');

        if ($dryRun) {
            $this->info('DRY RUN MODE - No changes will be made');
        }

        // Artisan has no user context, so RLS on the default 'pgsql' connection would
        // hide most rows. Use the BYPASSRLS admin connection so private books are covered
        // too (same reason embeddings:backfill uses pgsql_admin).
        \DB::connection('pgsql_admin')->disableQueryLog();

        // Build query (admin connection bypasses RLS)
        $query = PgNode::on('pgsql_admin')
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
        $affectedBooks = [];

        // Process in batches
        $query->chunkById(self::BATCH_SIZE, function ($nodes) use (&$processedCount, &$errorCount, &$affectedBooks, $bar) {
            foreach ($nodes as $node) {
                try {
                    // Generate plainText by stripping HTML tags
                    $plainText = strip_tags($node->content);

                    // Update directly to avoid triggering model events (which would be redundant)
                    // Admin connection to bypass RLS (matches the query connection).
                    PgNode::on('pgsql_admin')->where('id', $node->id)->update([
                        'plainText' => $plainText
                    ]);

                    $processedCount++;
                    $affectedBooks[$node->book] = true;
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

        // Re-queue embeddings for affected books. QueueBookEmbeddings only picks up nodes
        // where embedding IS NULL AND plainText IS NOT NULL AND length >= 20, and it uses
        // the admin connection so private books are covered.
        $bookCount = count($affectedBooks);
        if (! $noEmbed && $bookCount > 0) {
            foreach (array_keys($affectedBooks) as $affectedBook) {
                QueueBookEmbeddings::dispatch($affectedBook);
            }
            $this->info("Dispatched QueueBookEmbeddings for {$bookCount} book(s). Run the `embeddings` queue worker to generate them.");
        } elseif ($noEmbed) {
            $this->warn('--no-embed set — skipped embedding dispatch.');
        }

        $this->newLine();
        $this->info('Backfill complete! The tsvector search index will be updated automatically.');

        return 0;
    }
}
