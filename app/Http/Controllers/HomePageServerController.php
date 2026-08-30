<?php

/*This controller pulls the ranking columns from the library data table in postgreSQL:
[recent, total_highlights, hypercite_connections, reference_connections, created_at]
It processes them into three special books in the nodes table:
[most-recent, most-connected, most-lit]

This is calculated according to the following logic:
Most Recent: Uses the recent column directly (no processing needed)
Most Connected: Ranks by hypercite_connections, then reference_connections as a
  second key — so any text with a minted hypercite outranks every text without
  one, and below that line the not-yet-minted reference edges decide.
Most Lit: Ranks by hypercite_connections + total_highlights — human annotation
  activity, deliberately EXCLUDING the machine-detected reference edges so it
  says something different from Most Connected.
Both the SCORES and the SORTS are owned by App\Services\Connections\
ConnectionCountQuery (both directions, distinct counterparts, inbound weighted
double, self/same-owner edges dropped): this controller calls recompute() then
sortConnected()/sortLit() — the same delegation every shelf/user feed uses, so
all feeds agree. created_at (newest first) is the final tiebreaker. Card HTML
comes from the shared App\Services\LibraryCardGenerator (escaped citations,
bibtex-aware) — do not hand-roll cards or rankings here again.

call this in terminal to update the nodes table with:

curl -X POST http://localhost:8000/api/homepage/books/update \
  -H "Content-Type: application/json" \
  -H "Accept: application/json"

*/

namespace App\Http\Controllers;

use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Cache;
use Carbon\Carbon;
use App\Services\Connections\ConnectionCountQuery;
use App\Services\LibraryCardGenerator;

class HomePageServerController extends Controller
{
    private const CACHE_KEY = 'homepage_books_data';
    private const CACHE_TTL = 900; // 15 minutes
    private const PINNED_BOOK_ID = 'book_1773824629440';

    public function getHomePageBooks(Request $request)
    {
        // Fast path: serve the cached payload.
        $cached = Cache::get(self::CACHE_KEY);
        if ($cached !== null) {
            return $cached;
        }

        // F12: single-flight the rebuild. `Cache::remember` is NOT stampede-safe —
        // when the 15-min TTL lapses, every concurrent homepage load would otherwise
        // run generateHomePageBooks() at once and collide on the shared
        // most-recent/most-connected/most-lit node rows (unique index) → 500s + a
        // half-built homepage. Only ONE caller rebuilds under the lock; the rest
        // block briefly and then read the freshly-cached result.
        try {
            return Cache::lock(self::CACHE_KEY . ':rebuild', 60)->block(10, function () {
                return Cache::remember(self::CACHE_KEY, self::CACHE_TTL, fn () => $this->generateHomePageBooks());
            });
        } catch (LockTimeoutException $e) {
            // Couldn't acquire within 10s: serve cache if it landed, else generate
            // directly (degraded, but never error the homepage).
            return Cache::get(self::CACHE_KEY) ?? $this->generateHomePageBooks();
        }
    }

    public function updateHomePageBooks(Request $request, $forceUpdate = false)
    {
        if ($forceUpdate) {
            Cache::forget(self::CACHE_KEY);
        }

        // Serialise with the read-path rebuild (same lock) so two callers never
        // delete+insert the shared node rows at once (F12).
        try {
            return Cache::lock(self::CACHE_KEY . ':rebuild', 60)->block(10, function () {
                $result = $this->generateHomePageBooks();
                Cache::put(self::CACHE_KEY, $result, self::CACHE_TTL);
                return $result;
            });
        } catch (LockTimeoutException $e) {
            $result = $this->generateHomePageBooks();
            Cache::put(self::CACHE_KEY, $result, self::CACHE_TTL);
            return $result;
        }
    }

    private function generateHomePageBooks()
    {
        // Refresh the ranking columns FIRST, then read them. Corpus-wide and
        // set-based: this also runs inline on a cache miss, so it must never
        // become a per-book loop. Deliberately not restricted to `listed` books
        // — the harvested journal corpus is minted listed = false and its counts
        // were NULL forever because the old recompute skipped it. WHICH books
        // the homepage ranks is the separate `where('listed', true)` below.
        (new ConnectionCountQuery())->recompute();

        // Get all library records with the required columns, excluding unlisted books
        $cardColumns = [
            'book',
            'recent',
            'total_highlights',
            'hypercite_connections',
            'reference_connections',
            'total_views',
            'created_at',
            'bibtex',
            'title',
            'author',
            'year',
            'publisher',
            'journal',
            'encrypted',
        ];
        $libraryRecords = DB::table('library')
            ->select($cardColumns)
            ->where('listed', true)
            ->whereNotIn('visibility', ['private', 'deleted'])
            ->whereNotIn('book', ['stats', 'most-recent', 'most-connected', 'most-lit'])
            ->where('book', 'NOT LIKE', '%/%')
            ->get();

        // Use admin connection to bypass RLS for system-generated content
        $adminDb = DB::connection('pgsql_admin');

        // Pin book at top of most-recent. If it isn't in the ranked set (e.g.
        // unlisted) it's fetched separately and appears ONLY in most-recent —
        // it never enters the connected/lit rankings.
        $pinnedRecord = $libraryRecords->firstWhere('book', self::PINNED_BOOK_ID)
            ?? DB::table('library')
                ->select($cardColumns)
                ->where('book', self::PINNED_BOOK_ID)
                ->first();

        $mostRecent = $libraryRecords
            ->sortByDesc(fn ($r) => strtotime($r->created_at))
            ->reject(fn ($r) => $r->book === self::PINNED_BOOK_ID)
            ->values();
        if ($pinnedRecord) {
            $mostRecent->prepend($pinnedRecord);
        }

        // The one connectedness definition (review gate): both sorts delegate
        // to ConnectionCountQuery — never re-rank locally.
        $mostConnected = ConnectionCountQuery::sortConnected($libraryRecords)->values();
        $mostLit = ConnectionCountQuery::sortLit($libraryRecords)->values();

        // Clear existing entries for our special books
        $adminDb->table('nodes')->whereIn('book', [
            'most-recent',
            'most-connected',
            'most-lit'
        ])->delete();

        // Clear/create library entries for our special books
        $this->createLibraryEntries($adminDb);

        // Create entries for each special book
        $this->writeFeedNodes('most-recent', $mostRecent, $adminDb);
        $this->writeFeedNodes('most-connected', $mostConnected, $adminDb);
        $this->writeFeedNodes('most-lit', $mostLit, $adminDb);

        return response()->json([
            'success' => true,
            'message' => 'Homepage books updated successfully',
            'books_processed' => $libraryRecords->count(),
            'timestamp' => Carbon::now()
        ]);
    }

    private function createLibraryEntries($adminDb)
    {
        $currentTime = Carbon::now();
        $specialBooks = ['most-recent', 'most-connected', 'most-lit'];

        // Delete existing entries for special books
        $adminDb->table('library')->whereIn('book', $specialBooks)->delete();

        // Create new entries
        $libraryEntries = [];
        foreach ($specialBooks as $bookId) {
            $libraryEntries[] = [
                'book' => $bookId,
                'author' => 'hyperlit',
                'visibility' => 'public',
                'listed' => false,
                'raw_json' => json_encode([
                    'type' => 'generated',
                    'purpose' => 'homepage_ranking',
                    'book_id' => $bookId
                ]),
                'timestamp' => round(microtime(true) * 1000),
                'created_at' => $currentTime,
                'updated_at' => $currentTime
            ];
        }

        // Insert all library entries
        $adminDb->table('library')->insert($libraryEntries);
    }

    /**
     * Write one ranked feed as libraryCard nodes. Card HTML comes from the
     * shared LibraryCardGenerator (same cards as shelf/user-home renders —
     * escaped citations, data-node-id, card-citation wrapper).
     */
    private function writeFeedNodes(string $bookName, $records, $adminDb): void
    {
        $generator = new LibraryCardGenerator();
        $chunks = [];

        foreach ($records->values() as $i => $record) {
            // positionId = $i + 1 → startLine 1..N; the generator's
            // floor($i / 100) chunk math matches the old floor((pos - 1) / 100).
            $chunks[] = $generator->generateLibraryCardChunk($record, $bookName, $i + 1, false, false, $i);
        }

        foreach (array_chunk($chunks, 500) as $batch) {
            $adminDb->table('nodes')->insert($batch);
        }
    }

    public static function invalidateCache()
    {
        Cache::forget(self::CACHE_KEY);
    }

    // The per-book stats recompute that used to live here (recalculateLibraryStats
    // + countCitationsForBook + isSelfCitation) is gone: it ran two queries PER
    // BOOK, counted INBOUND hypercites only, and skipped every `listed = false`
    // book — which is the whole harvested journal corpus. Its replacement is the
    // set-based App\Services\Connections\ConnectionCountQuery, called at the top
    // of generateHomePageBooks(). Do not reintroduce a second definition of
    // "how connected is this book" here.
}
