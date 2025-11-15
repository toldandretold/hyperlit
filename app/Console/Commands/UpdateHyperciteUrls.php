<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use App\Models\PgNodeChunk;

/**
 * Update Hypercite URLs from Old Domains
 *
 * PURPOSE:
 * Replaces old domain URLs (libzen.io, libzen.com) with the canonical domain (hyperlit.io)
 * in hypercite links stored in the nodes table.
 *
 * WHY THIS IS NEEDED:
 * - When users paste hypercites, the link includes the full URL of the source page
 * - If the site was accessible via multiple domains, hypercites contain mixed URLs
 * - This breaks cross-document navigation when switching between domains
 * - This command normalizes all URLs to the canonical domain
 *
 * USAGE:
 * php artisan hypercites:update-urls                    # Update all books
 * php artisan hypercites:update-urls {book}             # Update specific book
 * php artisan hypercites:update-urls {book} --dry-run   # Preview changes
 *
 * EXAMPLE:
 * php artisan hypercites:update-urls book_1760156814805 --dry-run
 *
 * WHAT IT DOES:
 * 1. Finds all nodes with libzen.io or libzen.com URLs in content
 * 2. Replaces https://libzen.io with https://hyperlit.io
 * 3. Replaces https://libzen.com with https://hyperlit.io
 * 4. Preserves all paths, fragments, and query params after the domain
 * 5. Updates both content and raw_json columns
 * 6. Shows progress bar during operation
 */
class UpdateHyperciteUrls extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'hypercites:update-urls {book?} {--dry-run}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Replace libzen.io and libzen.com URLs with hyperlit.io in hypercite links';

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

        // Build query to find nodes with old domain URLs
        $query = PgNodeChunk::where(function($q) {
            $q->whereRaw("content LIKE '%https://libzen.io%'")
              ->orWhereRaw("content LIKE '%https://libzen.com%'");
        });

        if ($book) {
            $query->where('book', $book);
            $this->info("Targeting book: {$book}");
        } else {
            $this->info("Targeting ALL books");
        }

        $affectedChunks = $query->get();
        $totalCount = $affectedChunks->count();

        if ($totalCount === 0) {
            $this->info('✅ No old domain URLs found in content!');
            return 0;
        }

        $this->info("Found {$totalCount} chunks with old domain URLs");

        if ($dryRun) {
            $this->newLine();
            $this->info('📋 Sample of affected chunks:');
            $sample = $affectedChunks->take(5);

            foreach ($sample as $chunk) {
                $libzenIoCount = substr_count($chunk->content, 'libzen.io');
                $libzenComCount = substr_count($chunk->content, 'libzen.com');

                $this->line("  Book: {$chunk->book} | Line: {$chunk->startLine}");
                if ($libzenIoCount > 0) {
                    $this->line("    - libzen.io: {$libzenIoCount} occurrence(s)");
                }
                if ($libzenComCount > 0) {
                    $this->line("    - libzen.com: {$libzenComCount} occurrence(s)");
                }

                // Show a sample of what will change
                $preview = $this->getPreviewText($chunk->content);
                if ($preview) {
                    $this->line("    Preview: {$preview}");
                }
            }

            if ($totalCount > 5) {
                $this->line("  ... and " . ($totalCount - 5) . " more");
            }

            $this->newLine();
            $this->warn('⚠️  To actually update the URLs, run without --dry-run flag');
            return 0;
        }

        // Confirm before proceeding
        if (!$this->confirm("Update URLs in {$totalCount} chunks?", true)) {
            $this->info('❌ Cancelled');
            return 1;
        }

        $this->info('🔄 Updating URLs...');
        $bar = $this->output->createProgressBar($totalCount);
        $bar->start();

        $updatedCount = 0;
        $errorCount = 0;

        foreach ($affectedChunks as $chunk) {
            try {
                // Replace URLs in content
                $updatedContent = str_replace('https://libzen.io', 'https://hyperlit.io', $chunk->content);
                $updatedContent = str_replace('https://libzen.com', 'https://hyperlit.io', $updatedContent);

                // Also update raw_json if it exists
                if ($chunk->raw_json) {
                    $rawJson = is_string($chunk->raw_json)
                        ? json_decode($chunk->raw_json, true)
                        : $chunk->raw_json;

                    if (isset($rawJson['content'])) {
                        $rawJson['content'] = str_replace('https://libzen.io', 'https://hyperlit.io', $rawJson['content']);
                        $rawJson['content'] = str_replace('https://libzen.com', 'https://hyperlit.io', $rawJson['content']);
                        $chunk->raw_json = $rawJson;
                    }
                }

                $chunk->content = $updatedContent;
                $chunk->save();

                $updatedCount++;
            } catch (\Exception $e) {
                $errorCount++;
                $this->error("\nError updating chunk {$chunk->book}:{$chunk->startLine} - {$e->getMessage()}");
            }

            $bar->advance();
        }

        $bar->finish();
        $this->newLine(2);

        $this->info("✅ Updated {$updatedCount} chunks");

        if ($errorCount > 0) {
            $this->warn("⚠️  {$errorCount} errors occurred");
        }

        $this->newLine();
        $this->info('💡 Tip: Users should refresh their browser to see updated hypercite links');

        return 0;
    }

    /**
     * Get a preview snippet of what will change
     */
    private function getPreviewText($content)
    {
        // Find first occurrence of libzen URL
        if (preg_match('/https:\/\/libzen\.(io|com)[^\s"\'<>]*/', $content, $matches)) {
            $oldUrl = $matches[0];
            $newUrl = str_replace(['libzen.io', 'libzen.com'], 'hyperlit.io', $oldUrl);

            // Truncate if too long
            if (strlen($oldUrl) > 50) {
                $oldUrl = substr($oldUrl, 0, 47) . '...';
                $newUrl = substr($newUrl, 0, 47) . '...';
            }

            return "{$oldUrl} → {$newUrl}";
        }

        return null;
    }
}
