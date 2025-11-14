<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Hide Incomplete Library Entries
 *
 * PURPOSE:
 * Sets visibility = 'private' for library entries that have author as NULL.
 * This prevents incomplete/placeholder books from appearing on the homepage rankings.
 *
 * WHY THIS IS NEEDED:
 * - Placeholder books with NULL author pollute homepage rankings
 * - These are typically auto-generated entries or incomplete uploads
 * - Setting visibility = 'private' hides them from public homepage while preserving the data
 *
 * USAGE:
 * php artisan library:hide-incomplete                    # Process all books
 * php artisan library:hide-incomplete {book}             # Process specific book
 * php artisan library:hide-incomplete --dry-run          # Preview changes
 *
 * EXAMPLE:
 * php artisan library:hide-incomplete --dry-run
 * php artisan library:hide-incomplete book_1756078878692
 *
 * WHAT IT DOES:
 * 1. Finds library entries where author IS NULL
 * 2. Sets visibility = 'private' for these entries
 * 3. Shows progress bar during operation
 * 4. Reports count of updated entries
 */
class HideIncompleteLibraryEntries extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'library:hide-incomplete {book?} {--dry-run}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Set visibility=private for library entries with NULL author';

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

        // Build query for incomplete entries
        $query = DB::table('library')
            ->whereNull('author');

        if ($book) {
            $query->where('book', $book);
            $this->info("Targeting book: {$book}");
        } else {
            $this->info("Targeting ALL books");
        }

        // Get affected entries
        $affectedEntries = $query->get();
        $totalCount = $affectedEntries->count();

        if ($totalCount === 0) {
            $this->info('✅ No incomplete library entries found!');
            return 0;
        }

        $this->info("Found {$totalCount} incomplete entries (author IS NULL)");

        if ($dryRun) {
            $this->newLine();
            $this->info('📋 Sample of affected entries:');
            $sample = $affectedEntries->take(10);

            foreach ($sample as $entry) {
                $visibility = $entry->visibility ?? 'null';
                $listed = $entry->listed ? 'true' : 'false';
                $this->line("  Book: {$entry->book} | Visibility: {$visibility} | Listed: {$listed}");
            }

            if ($totalCount > 10) {
                $this->line("  ... and " . ($totalCount - 10) . " more");
            }

            $this->newLine();
            $this->warn('⚠️  To actually update the data, run without --dry-run flag');
            return 0;
        }

        // Confirm before proceeding
        if (!$this->confirm("Set visibility='private' for {$totalCount} entries?", true)) {
            $this->info('❌ Cancelled');
            return 1;
        }

        $this->info('🔒 Hiding incomplete library entries...');
        $bar = $this->output->createProgressBar($totalCount);
        $bar->start();

        $updatedCount = 0;
        $errorCount = 0;

        foreach ($affectedEntries as $entry) {
            try {
                DB::table('library')
                    ->where('book', $entry->book)
                    ->update([
                        'visibility' => 'private',
                        'updated_at' => now()
                    ]);

                $updatedCount++;
            } catch (\Exception $e) {
                $errorCount++;
                $this->error("\nError updating {$entry->book} - {$e->getMessage()}");
            }

            $bar->advance();
        }

        $bar->finish();
        $this->newLine(2);

        $this->info("✅ Updated {$updatedCount} entries to visibility='private'");

        if ($errorCount > 0) {
            $this->warn("⚠️  {$errorCount} errors occurred");
        }

        $this->newLine();
        $this->info('💡 Tip: Run the homepage update endpoint to refresh rankings');
        $this->line('   curl -X POST http://localhost:8000/api/homepage/books/update');

        return 0;
    }
}
