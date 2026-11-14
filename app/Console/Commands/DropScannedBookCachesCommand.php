<?php

namespace App\Console\Commands;

use App\Services\BookCache;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * citation:drop-scanned-caches — one-off repair for books scanned BEFORE the scan learned to
 * drop the book file cache (CitationScanBibliographyJob::dropStaleBookCache).
 *
 * Those books have their matches in Postgres but a cached bibliography.json / footnotes.json
 * from before the scan, which BookCache keeps serving because the scan never moved
 * `library.timestamp`. Re-running detect does not help: an already-scanned book is skipped, so
 * the new invalidation never fires for it. This drops the cache for every book with a completed
 * scan; the next read is live and re-warms it. Safe to re-run — it only deletes a cache.
 */
class DropScannedBookCachesCommand extends Command
{
    protected $signature = 'citation:drop-scanned-caches
        {--book= : Only this book id}
        {--dry-run : List the books without deleting anything}';

    protected $description = 'Drop the file cache of every book with a completed citation scan, so readers see its matches';

    public function handle(BookCache $cache): int
    {
        $books = DB::connection('pgsql_admin')->table('citation_scans')
            ->where('status', 'completed')
            ->when($this->option('book'), fn ($q, $book) => $q->where('book', $book))
            ->distinct()
            ->orderBy('book')
            ->pluck('book');

        $dry = (bool) $this->option('dry-run');
        foreach ($books as $book) {
            if (! $dry) {
                $cache->invalidate($book);
            }
            $this->line(($dry ? 'would drop  ' : 'dropped  ') . $book);
        }

        $this->info(($dry ? 'Would drop' : 'Dropped') . " the cache of {$books->count()} scanned book(s).");

        return self::SUCCESS;
    }
}
