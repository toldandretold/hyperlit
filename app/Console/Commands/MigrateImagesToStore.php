<?php

namespace App\Console\Commands;

use App\Services\LegacyImageMigrator;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * One-time backfill: move existing book images from the two legacy locations
 * into the unified private store, register book_images rows, and rewrite the
 * old public /storage/books/{id}/images/ srcs to the canonical /{id}/media/
 * URL (docs/e2ee.md). Run once, right after deploying the store cutover.
 *
 *   php artisan images:migrate-to-store              # all books
 *   php artisan images:migrate-to-store {book}       # one book
 *   php artisan images:migrate-to-store --dry-run    # preview
 *
 * Legacy A: storage/app/public/books/{id}/images/  (EPUB, /storage/books/... srcs → rewrite)
 * Legacy B: resources/markdown/{id}/media/         (DOCX/PDF/ZIP, /{id}/media/... srcs → unchanged)
 * All DB work is on the admin (BYPASSRLS) connection.
 */
class MigrateImagesToStore extends Command
{
    protected $signature = 'images:migrate-to-store {book?} {--dry-run}';

    protected $description = 'Move legacy book images into the unified private store + rewrite public /storage srcs';

    public function handle(LegacyImageMigrator $migrator): int
    {
        $dryRun = (bool) $this->option('dry-run');
        if ($dryRun) {
            $this->info('🔍 DRY RUN — no files moved, no rows written, no content rewritten');
        }

        $admin = DB::connection('pgsql_admin');

        // Root books only (sub-books share the root id; their images live under the root).
        $books = $admin->table('library')
            ->when($this->argument('book'), fn ($q) => $q->where('book', $this->argument('book')))
            ->where('book', 'not like', '%/%')
            ->pluck('book');

        if ($books->isEmpty()) {
            $this->info('No books to process.');

            return self::SUCCESS;
        }

        $bar = $this->output->createProgressBar($books->count());
        $bar->start();

        $totals = ['books' => 0, 'files' => 0, 'rewritten_nodes' => 0];

        foreach ($books as $book) {
            // The per-book migration is the same operation the encrypt transition
            // runs — one shared service (LegacyImageMigrator).
            $result = $migrator->migrateBook($book, $dryRun);
            if ($result['files'] > 0 || $result['had_public_images']) {
                $totals['books']++;
                $totals['files'] += $result['files'];
                $totals['rewritten_nodes'] += $result['rewritten_nodes'];
            }
            $bar->advance();
        }

        $bar->finish();
        $this->newLine(2);
        $this->table(
            ['books with images', 'files ingested', 'nodes rewritten'],
            [[$totals['books'], $totals['files'], $totals['rewritten_nodes']]],
        );

        return self::SUCCESS;
    }
}
