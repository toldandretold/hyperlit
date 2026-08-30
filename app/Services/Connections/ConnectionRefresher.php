<?php

namespace App\Services\Connections;

use App\Http\Controllers\HomePageServerController;
use App\Services\ShelfCacheInvalidator;

/**
 * Make a changed connection count VISIBLE. Recomputing the score is only half
 * the job: the feeds that rank on it are cached, and before this existed
 * nothing invalidated them when a hypercite was minted — a shelf's "Most
 * Connected" order stayed frozen at whatever it was the first time anyone
 * opened it, indefinitely, because ShelfCacheInvalidator was only ever called
 * from shelf MUTATIONS.
 *
 * Three things have to happen together, so they live in one place:
 *   1. recompute the touched books' columns,
 *   2. drop the rendered `shelf_{id}_{sort}` synthetic books that contain them,
 *   3. drop the homepage payload cache.
 *
 * Call this ONCE PER REQUEST with every touched book, not once per write — a
 * batch approve mints up to 25 hypercites and would otherwise flush the same
 * shelves 25 times.
 */
class ConnectionRefresher
{
    /** The sorts whose ORDER depends on a score that changes behind the render. */
    public const RANKING_SORTS = ['connected', 'lit'];

    /** Matches the homepage recompute cadence (UpdateHomepageJob, every 15 min). */
    public const RENDER_TTL_SECONDS = 900;

    /**
     * Should a cached feed render be thrown away and rebuilt? Only the RANKING
     * sorts expire — a title or publication-date order is stable, so those keep
     * the original indefinite cache.
     *
     * This is a backstop, not the primary mechanism: refresh() flushes precisely
     * when a hypercite is minted. It exists because the failure mode is silent
     * and total — a missed invalidation means the feed serves one frozen order
     * forever, which is exactly the bug this whole change is fixing.
     */
    public static function cachedRenderIsStale(string $syntheticBookId, string $sort): bool
    {
        if (! in_array($sort, self::RANKING_SORTS, true)) {
            return false;
        }

        $updatedAt = \Illuminate\Support\Facades\DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $syntheticBookId)
            ->value('updated_at');

        if ($updatedAt === null) {
            return true; // orphaned nodes with no synthetic library row — rebuild
        }

        return \Illuminate\Support\Carbon::parse($updatedAt)
            ->addSeconds(self::RENDER_TTL_SECONDS)
            ->isPast();
    }


    public function __construct(
        private ConnectionCountQuery $connections,
        private ShelfCacheInvalidator $shelves,
    ) {}

    /**
     * @param  array<int, ?string>  $books  Any mix of book / sub-book ids; nulls and
     *                                      duplicates are tolerated.
     * @return array<int, string> The shelf ids whose render cache was dropped.
     */
    public function refresh(array $books): array
    {
        $roots = array_values(array_unique(array_filter(array_map(
            fn ($b) => is_string($b) && $b !== '' ? ConnectionCountQuery::rootBook($b) : null,
            $books,
        ))));

        if ($roots === []) {
            return [];
        }

        $this->connections->recompute($roots);

        $shelfIds = [];
        foreach ($roots as $root) {
            $shelfIds = array_merge($shelfIds, $this->shelves->flushShelvesContaining($root));
        }

        HomePageServerController::invalidateCache();

        return array_values(array_unique($shelfIds));
    }

    /**
     * The CITING books named inside a hypercite's `citedIN` array. Each entry is
     * "/{citingBook}#{anchor}" — the citing side of an edge has no row of its
     * own, so this is the only place its identity appears on a write.
     *
     * @param  mixed  $citedIn  The raw payload value: array, JSON string, or junk.
     * @return array<int, string>
     */
    public static function booksFromCitedIn($citedIn): array
    {
        if (is_string($citedIn)) {
            $citedIn = json_decode($citedIn, true);
        }
        if (! is_array($citedIn)) {
            return [];
        }

        $books = [];
        foreach ($citedIn as $entry) {
            if (! is_string($entry)) {
                continue;
            }
            $path = ltrim(strtok($entry, '#'), '/');
            if ($path !== '' && $path !== false) {
                $books[] = ConnectionCountQuery::rootBook($path);
            }
        }

        return array_values(array_unique($books));
    }
}
