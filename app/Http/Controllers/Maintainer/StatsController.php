<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * /maintainer/stats — site-wide reading analytics: views (one book_reads row
 * per reader per day), likes, and depth over the whole corpus.
 *
 * Admin checked in-controller (non-admins 404), matching the sibling
 * maintainer pages; API behind auth:sanctum + admin in routes/api.php.
 * Reads ride pgsql_admin — aggregates must see every reader's rows.
 * Responses are aggregates only: reader identities never leave the server.
 */
class StatsController extends Controller
{
    /** GET /maintainer/stats */
    public function show(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        return view('maintainer-stats');
    }

    /** GET /api/maintainer/stats/summary — corpus totals. */
    public function summary()
    {
        // All-time views/books span raw rows + the de-identified rollups
        // (telemetry:rollup). `readers` is DELIBERATELY recent-window only:
        // rollups carry no identity, so an all-time distinct-reader count is
        // unknowable by design — that un-knowability is the privacy feature,
        // not a reporting gap. The 30-day window reads raw only (retention
        // floor guarantees raw covers it).
        $reads = DB::connection('pgsql_admin')->selectOne(<<<'SQL'
            SELECT (SELECT COUNT(*) FROM book_reads)
                 + (SELECT COALESCE(SUM(views), 0) FROM book_read_rollups) AS views,
                   COUNT(*) FILTER (WHERE read_date >= CURRENT_DATE - 29) AS views_30d,
                   COUNT(DISTINCT COALESCE(user_name, anon_token)) AS readers,
                   (SELECT COUNT(DISTINCT book) FROM (
                        SELECT book FROM book_reads
                        UNION
                        SELECT book FROM book_read_rollups
                    ) b) AS books_read
            FROM book_reads
        SQL);
        $likes = DB::connection('pgsql_admin')->selectOne(
            'SELECT COUNT(*) AS likes, COUNT(DISTINCT book) AS books_liked FROM book_likes'
        );

        // Homepage traffic. Counted the same way a book view is — one row per
        // identity per day — so "home views" and "views" are the same unit and
        // can sit next to each other without the tiles lying by a factor of
        // however many times someone refreshed.
        $home = DB::connection('pgsql_admin')->selectOne(<<<'SQL'
            SELECT (SELECT COUNT(*) FROM page_views WHERE page = 'home')
                 + (SELECT COALESCE(SUM(views), 0) FROM page_view_rollups WHERE page = 'home') AS views,
                   COUNT(*) FILTER (WHERE view_date >= CURRENT_DATE - 29) AS views_30d
            FROM page_views
            WHERE page = 'home'
        SQL);

        return response()->json([
            'views' => (int) ($reads->views ?? 0),
            'views_30d' => (int) ($reads->views_30d ?? 0),
            'readers' => (int) ($reads->readers ?? 0),
            'books_read' => (int) ($reads->books_read ?? 0),
            'likes' => (int) ($likes->likes ?? 0),
            'books_liked' => (int) ($likes->books_liked ?? 0),
            'home_views' => (int) ($home->views ?? 0),
            'home_views_30d' => (int) ($home->views_30d ?? 0),
        ]);
    }

    /** GET /api/maintainer/stats/daily — views + likes per day, last 90 days. */
    public function daily()
    {
        // Raw UNION rollups: the chart window (90d) and the raw-retention
        // window are the same order of magnitude, so chart days near the
        // boundary may already be de-identified — summing both sides keeps
        // the chart exact whatever telemetry.raw_retention_days is set to.
        $views = DB::connection('pgsql_admin')->select(<<<'SQL'
            SELECT day::text AS day, SUM(n) AS n FROM (
                SELECT read_date AS day, COUNT(*) AS n
                FROM book_reads
                WHERE read_date >= CURRENT_DATE - 89
                GROUP BY read_date
                UNION ALL
                SELECT read_date AS day, views AS n
                FROM book_read_rollups
                WHERE read_date >= CURRENT_DATE - 89
            ) u GROUP BY day ORDER BY day
        SQL);
        $likes = DB::connection('pgsql_admin')->select(<<<'SQL'
            SELECT created_at::date::text AS day, COUNT(*) AS n
            FROM book_likes
            WHERE created_at >= CURRENT_DATE - 89
            GROUP BY created_at::date
            ORDER BY 1
        SQL);

        $home = DB::connection('pgsql_admin')->select(<<<'SQL'
            SELECT day::text AS day, SUM(n) AS n FROM (
                SELECT view_date AS day, COUNT(*) AS n
                FROM page_views
                WHERE page = 'home' AND view_date >= CURRENT_DATE - 89
                GROUP BY view_date
                UNION ALL
                SELECT view_date AS day, views AS n
                FROM page_view_rollups
                WHERE page = 'home' AND view_date >= CURRENT_DATE - 89
            ) u GROUP BY day ORDER BY day
        SQL);

        return response()->json([
            'views' => array_map(fn ($r) => ['day' => $r->day, 'n' => (int) $r->n], $views),
            'likes' => array_map(fn ($r) => ['day' => $r->day, 'n' => (int) $r->n], $likes),
            'home' => array_map(fn ($r) => ['day' => $r->day, 'n' => (int) $r->n], $home),
        ]);
    }

    /** GET /api/maintainer/stats/top-books — the most-read books, with likes and average depth. */
    public function topBooks()
    {
        // avg_depth: mean of each view's (max_chunk / total_chunks), only over
        // rows that know their denominator — a rough "how far did readers get".
        // All-time views = raw + rollups; views_30d and avg_depth come from
        // the RAW (identity-bearing, recent) rows only — depth detail is
        // deliberately not preserved past the retention window.
        $rows = DB::connection('pgsql_admin')->select(<<<'SQL'
            SELECT u.book,
                   l.title,
                   l.creator,
                   SUM(u.views) AS views,
                   SUM(u.views_30d) AS views_30d,
                   COALESCE(l.total_likes, 0) AS likes,
                   ROUND((SUM(u.depth_sum) / NULLIF(SUM(u.depth_n), 0) * 100)::numeric, 1) AS avg_depth_pct
            FROM (
                SELECT r.book,
                       COUNT(*) AS views,
                       COUNT(*) FILTER (WHERE r.read_date >= CURRENT_DATE - 29) AS views_30d,
                       SUM(r.max_chunk::float / NULLIF(r.total_chunks, 0)) FILTER (
                           WHERE r.max_chunk IS NOT NULL AND r.total_chunks IS NOT NULL
                       ) AS depth_sum,
                       COUNT(*) FILTER (
                           WHERE r.max_chunk IS NOT NULL AND r.total_chunks IS NOT NULL
                       ) AS depth_n
                FROM book_reads r
                GROUP BY r.book
                UNION ALL
                SELECT book, SUM(views), 0, NULL, 0
                FROM book_read_rollups
                GROUP BY book
            ) u
            LEFT JOIN library l ON l.book = u.book
            WHERE u.book <> 'stats'
            GROUP BY u.book, l.title, l.creator, l.total_likes
            ORDER BY views DESC, u.book ASC
            LIMIT 50
        SQL);

        return response()->json([
            'books' => array_map(fn ($r) => [
                'book' => $r->book,
                'title' => $r->title,
                'creator' => $r->creator,
                'views' => (int) $r->views,
                'views_30d' => (int) $r->views_30d,
                'likes' => (int) $r->likes,
                'avg_depth_pct' => $r->avg_depth_pct !== null ? (float) $r->avg_depth_pct : null,
            ], $rows),
        ]);
    }
}
