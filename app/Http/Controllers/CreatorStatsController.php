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
     * Depth funnel for one owned book: per decile of the book's chunk range,
     * the % of views (book_reads rows) that had at least one chunk from that
     * decile on screen.
     *
     * @return JsonResponse array{book: string, total_views: int, total_chunks: ?int,
     *   max_chunk_reached: ?float, deciles: array<int, array{decile: int, pct: float}>}
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

            // Latest-known chunk count; fall back to counting the live nodes so
            // a brand-new book (no telemetry yet / old rows without a total)
            // still gets a denominator.
            $totalChunks = $summary->total_chunks !== null ? (int) $summary->total_chunks : null;
            if (! $totalChunks) {
                $nodeChunks = DB::connection('pgsql_admin')->selectOne(
                    'SELECT COUNT(DISTINCT chunk_id) AS n FROM nodes WHERE book = ?',
                    [$book]
                );
                $totalChunks = (int) ($nodeChunks->n ?? 0) ?: null;
            }

            $deciles = [];
            if ($views > 0 && $totalChunks) {
                $rows = DB::connection('pgsql_admin')->select(<<<'SQL'
                    SELECT LEAST(9, GREATEST(0, FLOOR((v.value::float / ?) * 10)))::int AS decile,
                           COUNT(DISTINCT r.id) AS readers
                    FROM book_reads r
                    CROSS JOIN LATERAL jsonb_array_elements_text(r.chunks_viewed) AS v(value)
                    WHERE r.book = ?
                    GROUP BY 1
                SQL, [$totalChunks, $book]);
                $byDecile = [];
                foreach ($rows as $r) {
                    $byDecile[(int) $r->decile] = (int) $r->readers;
                }
                for ($d = 0; $d < 10; $d++) {
                    $deciles[] = [
                        'decile' => $d,
                        'pct' => round((($byDecile[$d] ?? 0) / $views) * 100, 1),
                    ];
                }
            }

            return response()->json([
                'book' => $book,
                'total_views' => $views,
                'total_chunks' => $totalChunks,
                'max_chunk_reached' => $summary->max_chunk !== null ? (float) $summary->max_chunk : null,
                'deciles' => $deciles,
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
