<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use App\Models\PgNodeChunk;

/**
 * Strip <mark> Tags from node_chunks Content
 *
 * PURPOSE:
 * Removes <mark> tags from the content and raw_json columns in the node_chunks table.
 * Highlights should be dynamically injected on page load from the hyperlights array data,
 * not persisted in the content itself.
 *
 * WHY THIS IS NEEDED:
 * - Highlights are stored separately in the 'hyperlights' array field on each node_chunk
 * - On page load, the frontend reads hyperlights data and injects <mark> tags into the DOM
 * - If <mark> tags get saved to the database (e.g., via emergency rescue function or paste operations),
 *   they will be duplicated when the frontend injects them again
 * - This command cleans up any persisted <mark> tags to maintain data integrity
 *
 * USAGE:
 * php artisan content:strip-mark-tags                    # Clean all books
 * php artisan content:strip-mark-tags {book}             # Clean specific book
 * php artisan content:strip-mark-tags {book} --dry-run   # Preview changes
 *
 * EXAMPLE:
 * php artisan content:strip-mark-tags book_1760156814805 --dry-run
 *
 * WHAT IT DOES:
 * 1. Finds all node_chunks with <mark> tags in content
 * 2. Strips both opening <mark> tags (with any attributes) and closing </mark> tags
 * 3. Also cleans raw_json column if it exists
 * 4. Shows progress bar during operation
 * 5. After cleaning, users should refresh their browser to see clean content
 *    (highlights will be re-injected from hyperlights data)
 */
class StripMarkTagsFromContent extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'content:strip-mark-tags {book?} {--dry-run}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Remove <mark> tags from node_chunks content column (highlights are injected on page load)';

    /**
     * Execute the console command.
     */
    public function handle()
    {
        $book = $this->argument('book');
        $dryRun = $this->option('dry-run');

        if ($dryRun) {
            $this->info('🔍 DRY RUN MODE - No changes will be made');
        }

        // Build query
        $query = PgNodeChunk::whereRaw("content LIKE '%<mark%'");

        if ($book) {
            $query->where('book', $book);
            $this->info("Targeting book: {$book}");
        } else {
            $this->info("Targeting ALL books");
        }

        $affectedChunks = $query->get();
        $totalCount = $affectedChunks->count();

        if ($totalCount === 0) {
            $this->info('✅ No <mark> tags found in content!');
            return 0;
        }

        $this->info("Found {$totalCount} chunks with <mark> tags");

        if ($dryRun) {
            $this->newLine();
            $this->info('📋 Sample of affected chunks:');
            $sample = $affectedChunks->take(5);

            foreach ($sample as $chunk) {
                $markCount = substr_count($chunk->content, '<mark');
                $this->line("  Book: {$chunk->book} | Line: {$chunk->startLine} | Marks: {$markCount}");
            }

            if ($totalCount > 5) {
                $this->line("  ... and " . ($totalCount - 5) . " more");
            }

            $this->newLine();
            $this->warn('⚠️  To actually clean the data, run without --dry-run flag');
            return 0;
        }

        // Confirm before proceeding
        if (!$this->confirm("Clean {$totalCount} chunks?", true)) {
            $this->info('❌ Cancelled');
            return 1;
        }

        $this->info('🧹 Cleaning <mark> tags...');
        $bar = $this->output->createProgressBar($totalCount);
        $bar->start();

        $cleanedCount = 0;
        $errorCount = 0;

        foreach ($affectedChunks as $chunk) {
            try {
                // Strip opening <mark> tags (with any attributes)
                $cleanedContent = preg_replace('/<mark[^>]*>/', '', $chunk->content);

                // Strip closing </mark> tags
                $cleanedContent = str_replace('</mark>', '', $cleanedContent);

                // Also clean raw_json if it exists
                if ($chunk->raw_json) {
                    $rawJson = is_string($chunk->raw_json)
                        ? json_decode($chunk->raw_json, true)
                        : $chunk->raw_json;

                    if (isset($rawJson['content'])) {
                        $rawJson['content'] = preg_replace('/<mark[^>]*>/', '', $rawJson['content']);
                        $rawJson['content'] = str_replace('</mark>', '', $rawJson['content']);
                        $chunk->raw_json = $rawJson;
                    }
                }

                $chunk->content = $cleanedContent;
                $chunk->save();

                $cleanedCount++;
            } catch (\Exception $e) {
                $errorCount++;
                $this->error("\nError cleaning chunk {$chunk->book}:{$chunk->startLine} - {$e->getMessage()}");
            }

            $bar->advance();
        }

        $bar->finish();
        $this->newLine(2);

        $this->info("✅ Cleaned {$cleanedCount} chunks");

        if ($errorCount > 0) {
            $this->warn("⚠️  {$errorCount} errors occurred");
        }

        $this->newLine();
        $this->info('💡 Tip: Refresh your browser to see clean content (highlights will be re-injected from hyperlights data)');

        return 0;
    }
}
