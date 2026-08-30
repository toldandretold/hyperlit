<?php

namespace App\Console\Commands;

use App\Http\Controllers\HomePageServerController;
use App\Services\Connections\ConnectionCountQuery;
use App\Services\ShelfCacheInvalidator;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Recompute the docuverse-connectedness columns the Most Connected / Most Lit
 * feeds rank on. The 15-minute homepage job does this corpus-wide already —
 * this command exists for the initial backfill (every book is NULL until it has
 * run once), for a targeted re-check of one book, and for re-running after the
 * weighting in ConnectionCountQuery changes.
 */
class RecomputeConnectionsCommand extends Command
{
    protected $signature = 'library:recompute-connections
                            {--book=* : Restrict to these books (repeatable); default is the whole corpus}
                            {--no-flush : Skip flushing the shelf render caches}';

    protected $description = 'Recompute hypercite_connections / reference_connections / total_highlights';

    public function handle(ConnectionCountQuery $connections, ShelfCacheInvalidator $shelves): int
    {
        $books = $this->option('book') ?: null;

        $this->info($books ? 'Recomputing ' . count($books) . ' book(s)…' : 'Recomputing the whole corpus…');

        $changed = $connections->recompute($books);
        $this->info("Rows changed: {$changed}");

        if ($this->option('no-flush')) {
            return self::SUCCESS;
        }

        // A changed score only becomes VISIBLE once the rendered feed is thrown
        // away: shelf renders are cached as synthetic `shelf_{id}_{sort}` books
        // in `nodes` and are otherwise served forever.
        HomePageServerController::invalidateCache();

        if ($books === null) {
            $flushed = DB::connection('pgsql_admin')->table('nodes')
                ->where('book', 'LIKE', 'shelf\_%')
                ->delete();
            DB::connection('pgsql_admin')->table('library')
                ->where('book', 'LIKE', 'shelf\_%')
                ->delete();
            $this->info("Flushed every shelf render ({$flushed} node rows).");

            return self::SUCCESS;
        }

        $shelfIds = [];
        foreach ($books as $book) {
            $shelfIds = array_merge($shelfIds, $shelves->flushShelvesContaining(ConnectionCountQuery::rootBook($book)));
        }
        $this->info('Flushed ' . count(array_unique($shelfIds)) . ' shelf render(s).');

        return self::SUCCESS;
    }
}
