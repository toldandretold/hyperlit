<?php

namespace App\Http\Controllers;

use App\Helpers\BookSlugHelper;
use App\Services\Connections\ConnectionCountQuery;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Creator-facing reading stats — AGGREGATES ONLY. book_reads rows carry reader
 * identities (user_name / anon_token) purely for per-day dedup; nothing in
 * these responses may ever include them. Reads ride pgsql_admin because the
 * aggregates must count every reader's rows, not just the requester's.
 */
class CreatorStatsController extends Controller
{
    /** Page size for the stats list — the client's "Load more" step. */
    private const PAGE_SIZE = 100;

    /**
     * Sortable columns, whitelisted. The VALUE is interpolated into the ORDER
     * BY, so this map is the injection boundary — never take a raw sort key
     * from the request. `book ASC` is appended everywhere as a tiebreak: a
     * paged query with a non-unique sort can otherwise repeat or skip rows
     * across pages.
     */
    private const SORTS = [
        'views' => 'total_views DESC',
        'likes' => 'likes DESC',
        'recent' => 'created_at DESC NULLS LAST',
        'title' => 'LOWER(COALESCE(title, book)) ASC',
        'author' => 'LOWER(COALESCE(author, \'\')) ASC',
    ];

    /**
     * Per-book summaries for the root books the requester created.
     *
     * Paged (`?offset=`, PAGE_SIZE at a time), sortable (`?sort=`) and
     * searchable (`?q=` over title + author). `total` is the unfiltered-by-page
     * count so the UI can say "100 of 6722" — the previous version returned a
     * bare `LIMIT 500` with no count, which silently hid the rest of a large
     * creator's corpus.
     *
     * @return JsonResponse array{books: array<int, array{book: string, title: ?string,
     *   author: ?string, total_views: int, views_30d: int, likes: int, total_chunks: ?int}>,
     *   total: int, offset: int, limit: int}
     */
    public function index(Request $request): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $sortKey = (string) $request->query('sort', 'views');
        $orderBy = self::SORTS[$sortKey] ?? self::SORTS['views'];
        $offset = max(0, (int) $request->query('offset', 0));
        $search = trim((string) $request->query('q', ''));

        // Bind the search twice (title, author) or not at all — keep the
        // fragment and its bindings built together so they can't drift apart.
        $searchSql = '';
        $searchBindings = [];
        if ($search !== '') {
            $searchSql = ' AND (l.title ILIKE ? OR l.author ILIKE ?)';
            $like = '%' . str_replace(['%', '_'], ['\%', '\_'], $search) . '%';
            $searchBindings = [$like, $like];
        }

        try {
            $where = "l.creator = ?
                  AND l.book NOT LIKE '%/%'
                  AND COALESCE(l.visibility, 'public') <> 'deleted'" . $searchSql;

            $total = (int) DB::connection('pgsql_admin')->selectOne(
                "SELECT COUNT(*) AS n FROM library l WHERE {$where}",
                array_merge([$user->name], $searchBindings)
            )->n;

            // PAGE FIRST, then aggregate. Two things make this cheap, and both
            // are load-bearing:
            //
            // 1. The inner query touches ONLY `library` columns — including
            //    `total_views`/`total_likes`, which are denormalized and
            //    maintained by ReadStatsCounter (its sole writer). So every
            //    sort is over an indexable column and the LIMIT applies before
            //    any aggregation. Sorting on a computed aggregate instead
            //    forced the read-count for all 6.7k of a large creator's books
            //    to be evaluated just to pick the top 100.
            // 2. The read aggregate is a LATERAL correlated to the paged row,
            //    NOT a standalone `GROUP BY book` over the whole table. The old
            //    shape aggregated EVERY row of book_reads — every view of every
            //    book by every user — then hash-joined one creator's books
            //    against it, so its cost grew with total product usage rather
            //    than with the requester's corpus. Now it runs <=100 times, each
            //    an index probe on (book, read_date).
            //
            // The outer ORDER BY repeats the inner one: a LATERAL join does not
            // promise to preserve subquery order.
            $rows = DB::connection('pgsql_admin')->select(
                "SELECT p.book,
                        p.title,
                        p.author,
                        p.total_views,
                        p.likes,
                        COALESCE(r.views_30d, 0) AS views_30d,
                        r.total_chunks
                 FROM (
                     SELECT l.book,
                            l.title,
                            l.author,
                            l.created_at,
                            COALESCE(l.total_views, 0) AS total_views,
                            COALESCE(l.total_likes, 0) AS likes
                     FROM library l
                     WHERE {$where}
                     ORDER BY {$orderBy}, l.book ASC
                     LIMIT ? OFFSET ?
                 ) p
                 LEFT JOIN LATERAL (
                     SELECT COUNT(*) FILTER (WHERE br.read_date >= CURRENT_DATE - 29) AS views_30d,
                            MAX(br.total_chunks) AS total_chunks
                     FROM book_reads br
                     WHERE br.book = p.book
                 ) r ON TRUE
                 ORDER BY {$orderBy}, p.book ASC",
                array_merge([$user->name], $searchBindings, [self::PAGE_SIZE, $offset])
            );

            return response()->json([
                'books' => array_map(fn ($r) => [
                    'book' => $r->book,
                    'title' => $r->title,
                    'author' => $r->author,
                    'total_views' => (int) $r->total_views,
                    'views_30d' => (int) $r->views_30d,
                    'likes' => (int) $r->likes,
                    'total_chunks' => $r->total_chunks !== null ? (int) $r->total_chunks : null,
                ], $rows),
                'total' => $total,
                'offset' => $offset,
                'limit' => self::PAGE_SIZE,
            ]);
        } catch (\Exception $e) {
            Log::error('Creator stats index failed', ['error' => $e->getMessage()]);

            return response()->json(['error' => 'Internal server error'], 500);
        }
    }

    /**
     * Depth funnel for one owned book: per CHUNK (the book's real render unit,
     * ~100 nodes), the % of views (book_reads rows) that had that chunk on
     * screen. One bar = one actual chunk — the earlier decile version bucketed
     * on floor(chunk_id / total * 10), which for the typical 1–3-chunk article
     * could never light anything past the first bars and read as "nobody
     * scrolls" when the book was simply too short for decile resolution.
     *
     * The x-axis is the LIVE ordered chunk list from `nodes` (fractional ids
     * from chunk splits included); viewed ids that no longer exist (recorded
     * before a reconvert re-chunked the book) are dropped rather than guessed
     * onto the wrong bar.
     *
     * @return JsonResponse array{book: string, total_views: int, total_chunks: ?int,
     *   max_chunk_reached: ?float, chunks: array<int, array{chunk: int, pct: float}>}
     */
    public function show(Request $request, string $book): JsonResponse
    {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        try {
            $book = ConnectionCountQuery::rootBook(BookSlugHelper::resolve($book));

            $owned = DB::connection('pgsql_admin')
                ->table('library')
                ->where('book', $book)
                ->where('creator', $user->name)
                ->exists();
            if (! $owned) {
                return response()->json(['error' => 'Not found'], 404);
            }

            $summary = DB::connection('pgsql_admin')->selectOne(
                'SELECT COUNT(*) AS views, MAX(total_chunks) AS total_chunks, MAX(max_chunk) AS max_chunk
                 FROM book_reads WHERE book = ?',
                [$book]
            );
            $views = (int) ($summary->views ?? 0);

            // The bar axis: the book's real chunks, in reading order. Keyed by
            // the id's float string form so a jsonb-roundtripped "2.5" and the
            // numeric column value land on the same bucket.
            $liveChunks = array_map(
                fn ($r) => (float) $r->chunk_id,
                DB::connection('pgsql_admin')->select(
                    'SELECT DISTINCT chunk_id FROM nodes WHERE book = ? ORDER BY chunk_id',
                    [$book]
                )
            );
            $totalChunks = count($liveChunks) ?: null;
            if (! $totalChunks) {
                // No live nodes (content cleared mid-reconvert): synthesize a
                // 0..n-1 axis from the telemetry's own best-known count rather
                // than showing nothing.
                $fallback = (int) ($summary->total_chunks ?? 0);
                if ($fallback > 0) {
                    $liveChunks = array_map('floatval', range(0, $fallback - 1));
                    $totalChunks = $fallback;
                }
            }

            $chunks = [];
            if ($views > 0 && $totalChunks) {
                $rows = DB::connection('pgsql_admin')->select(<<<'SQL'
                    SELECT v.value::float AS chunk,
                           COUNT(DISTINCT r.id) AS readers
                    FROM book_reads r
                    CROSS JOIN LATERAL jsonb_array_elements_text(r.chunks_viewed) AS v(value)
                    WHERE r.book = ?
                    GROUP BY 1
                SQL, [$book]);
                $readersByChunk = [];
                foreach ($rows as $r) {
                    $readersByChunk[(string) (float) $r->chunk] = (int) $r->readers;
                }
                foreach ($liveChunks as $i => $chunkId) {
                    $chunks[] = [
                        'chunk' => $i + 1, // 1-based ordinal for display
                        'pct' => round((($readersByChunk[(string) $chunkId] ?? 0) / $views) * 100, 1),
                    ];
                }
            }

            return response()->json([
                'book' => $book,
                'total_views' => $views,
                'total_chunks' => $totalChunks,
                'max_chunk_reached' => $summary->max_chunk !== null ? (float) $summary->max_chunk : null,
                'chunks' => $chunks,
            ]);
        } catch (\Exception $e) {
            Log::error('Creator stats detail failed', [
                'book' => $book,
                'error' => $e->getMessage(),
            ]);

            return response()->json(['error' => 'Internal server error'], 500);
        }
    }
}
