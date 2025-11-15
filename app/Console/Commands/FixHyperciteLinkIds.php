<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use App\Models\PgNodeChunk;

/**
 * Fix Hypercite Link IDs
 *
 * PURPOSE:
 * Repairs broken hypercite link IDs by looking up the correct ID from the hypercite database.
 *
 * THE PROBLEM:
 * Hypercite links should have IDs that match the citedIN array from the target hypercite.
 * For example:
 *   <a href="http://localhost:8000/book_123#hypercite_abc" id="hypercite_xyz">
 * The ID "hypercite_xyz" should come from the citedIN array of hypercite_abc.
 * Sometimes these IDs get corrupted (e.g., id="1000" instead of proper hypercite ID).
 *
 * HOW IT WORKS:
 * 1. Scans all nodes for hypercite links
 * 2. Extracts the target hypercite ID from the href (part after #)
 * 3. Looks up that hypercite in the database
 * 4. Gets the citedIN array from the hypercite
 * 5. Extracts the proper ID from citedIN (part after #)
 * 6. Updates the link's id attribute if it doesn't match
 *
 * USAGE:
 * php artisan hypercite:fix-link-ids                    # Fix all books
 * php artisan hypercite:fix-link-ids {book}             # Fix specific book
 * php artisan hypercite:fix-link-ids {book} --dry-run   # Preview changes
 *
 * EXAMPLE:
 * php artisan hypercite:fix-link-ids book_1760239151678 --dry-run
 */
class FixHyperciteLinkIds extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'hypercite:fix-link-ids {book?} {--dry-run}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Fix broken hypercite link IDs by looking up correct IDs from citedIN arrays';

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

        // Build query for chunks that contain hypercite links
        $query = PgNodeChunk::whereRaw("content LIKE '%<a href=%#hypercite_%'");

        if ($book) {
            $query->where('book', $book);
            $this->info("Targeting book: {$book}");
        } else {
            $this->info("Targeting ALL books");
        }

        $chunks = $query->get();
        $totalChunks = $chunks->count();

        if ($totalChunks === 0) {
            $this->info('✅ No hypercite links found!');
            return 0;
        }

        $this->info("Found {$totalChunks} chunks with hypercite links");
        $this->newLine();

        $fixedCount = 0;
        $errorCount = 0;
        $unchangedCount = 0;
        $changesPreview = [];

        foreach ($chunks as $chunk) {
            try {
                $content = $chunk->content;
                $modified = false;

                // Pattern to match hypercite links: <a href="...#hypercite_XXX" id="YYY">
                $pattern = '/<a\s+href="([^"]*#(hypercite_[^"]+))"\s+id="([^"]+)"([^>]*)>/i';

                $newContent = preg_replace_callback($pattern, function($matches) use ($chunk, &$modified, &$errorCount, &$changesPreview, $dryRun) {
                    $fullHref = $matches[1];
                    $targetHyperciteId = $matches[2]; // hypercite_XXX from href
                    $currentId = $matches[3]; // current id attribute value
                    $remainingAttrs = $matches[4];

                    // Parse the book from the href
                    preg_match('~/([^/]+)#hypercite_~', $fullHref, $bookMatch);
                    $targetBook = $bookMatch[1] ?? $chunk->book;

                    // Look up the target hypercite in the database
                    $hypercite = DB::table('hypercites')
                        ->where('book', $targetBook)
                        ->where('hyperciteId', $targetHyperciteId)
                        ->first();

                    if (!$hypercite) {
                        $this->warn("  ⚠️  Hypercite not found: {$targetHyperciteId} in book {$targetBook}");
                        $errorCount++;
                        return $matches[0]; // return unchanged
                    }

                    // Get citedIN array
                    $citedIN = $hypercite->citedIN;
                    if (is_string($citedIN)) {
                        $citedIN = json_decode($citedIN, true);
                    }

                    if (empty($citedIN) || !is_array($citedIN)) {
                        // No citations, can't determine correct ID
                        return $matches[0]; // return unchanged
                    }

                    // Extract hypercite ID from citedIN array (part after #)
                    $correctId = null;
                    foreach ($citedIN as $citation) {
                        if (preg_match('/#(hypercite_[^#]+)$/', $citation, $citedMatch)) {
                            $correctId = $citedMatch[1];
                            break;
                        }
                    }

                    if (!$correctId) {
                        $this->warn("  ⚠️  Could not extract ID from citedIN for {$targetHyperciteId}");
                        $errorCount++;
                        return $matches[0]; // return unchanged
                    }

                    // Check if ID needs fixing
                    if ($currentId === $correctId) {
                        // Already correct, no change needed
                        return $matches[0];
                    }

                    // ID needs fixing
                    $modified = true;

                    if ($dryRun) {
                        $changesPreview[] = [
                            'book' => $chunk->book,
                            'line' => $chunk->startLine,
                            'target' => $targetHyperciteId,
                            'old_id' => $currentId,
                            'new_id' => $correctId,
                        ];
                    }

                    // Return corrected link
                    return "<a href=\"{$fullHref}\" id=\"{$correctId}\"{$remainingAttrs}>";

                }, $content);

                if ($modified && !$dryRun) {
                    $chunk->content = $newContent;
                    $chunk->save();
                    $fixedCount++;
                } elseif ($modified && $dryRun) {
                    $fixedCount++;
                } else {
                    $unchangedCount++;
                }

            } catch (\Exception $e) {
                $errorCount++;
                $this->error("Error processing chunk {$chunk->book}:{$chunk->startLine} - {$e->getMessage()}");
            }
        }

        $this->newLine();

        if ($dryRun && count($changesPreview) > 0) {
            $this->info('📋 Preview of changes to be made:');
            $this->newLine();

            $sample = array_slice($changesPreview, 0, 10);
            foreach ($sample as $change) {
                $this->line("  Book: {$change['book']} | Line: {$change['line']}");
                $this->line("    Target: {$change['target']}");
                $this->line("    ID: {$change['old_id']} → {$change['new_id']}");
                $this->newLine();
            }

            if (count($changesPreview) > 10) {
                $this->line("  ... and " . (count($changesPreview) - 10) . " more changes");
            }

            $this->newLine();
            $this->warn('⚠️  To apply these fixes, run without --dry-run flag');
        } elseif ($dryRun) {
            $this->info('✅ No changes needed!');
        }

        // Summary
        if (!$dryRun && $fixedCount > 0) {
            $this->info("✅ Fixed {$fixedCount} chunks");
        }

        if ($unchangedCount > 0) {
            $this->info("ℹ️  {$unchangedCount} chunks already had correct IDs");
        }

        if ($errorCount > 0) {
            $this->warn("⚠️  {$errorCount} errors or warnings occurred");
        }

        if (!$dryRun && $fixedCount > 0) {
            $this->newLine();
            $this->info('💡 Tip: Refresh your browser to see the fixed hypercite links');
        }

        return 0;
    }
}
