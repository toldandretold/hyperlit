<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Services\Storage\StorageScanner;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * /maintainer/storage — what Hyperlit is holding, and how much of it is waste.
 *
 * Reads the latest `storage_scans` snapshot rather than measuring per request;
 * the scan is nightly (routes/console.php) plus an on-demand rescan, which runs
 * SYNCHRONOUSLY because the walk measures ~2s over ~70k files. If that ever
 * stops being true, move the rescan to the light `embeddings` queue — never to
 * `default`, which must not queue behind imports.
 *
 * Admin checked in-controller (non-admins 404), matching the sibling maintainer
 * pages; API behind auth:sanctum + admin in routes/api.php.
 */
class StorageController extends Controller
{
    /** Categories whose bytes are safe to lose — regenerable or already migrated. */
    private const RECLAIMABLE = StorageScanner::RECLAIMABLE;

    /** GET /maintainer/storage */
    public function show(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        return view('maintainer-storage');
    }

    /** GET /api/maintainer/storage/summary — the latest snapshot, shaped for the page. */
    public function summary()
    {
        $scan = DB::table('storage_scans')->orderByDesc('id')->first();

        if (! $scan) {
            return response()->json(['scan' => null]);
        }

        $categories = DB::table('storage_scan_items')
            ->where('scan_id', $scan->id)
            ->selectRaw('category, SUM(bytes) AS bytes, SUM(file_count) AS file_count,
                         SUM(CASE WHEN is_orphan THEN bytes ELSE 0 END) AS orphan_bytes')
            ->groupBy('category')
            ->orderByDesc('bytes')
            ->get()
            ->map(fn ($r) => [
                'category' => $r->category,
                'bytes' => (int) $r->bytes,
                'file_count' => (int) $r->file_count,
                'orphan_bytes' => (int) $r->orphan_bytes,
                'reclaimable' => in_array($r->category, self::RECLAIMABLE, true),
            ]);

        $notes = json_decode((string) $scan->notes, true) ?: [];

        return response()->json([
            'scan' => [
                'id' => $scan->id,
                'finished_at' => $scan->finished_at,
                'age_seconds' => $scan->finished_at ? now()->diffInSeconds($scan->finished_at, true) : null,
                'duration_ms' => $scan->duration_ms,
            ],
            'totals' => [
                'total_bytes' => (int) $scan->total_bytes,
                'db_bytes' => (int) $scan->db_bytes,
                'file_bytes' => (int) $scan->file_bytes,
                'orphan_bytes' => (int) $scan->orphan_bytes,
                'disk_free_bytes' => $scan->disk_free_bytes ? (int) $scan->disk_free_bytes : null,
                'disk_total_bytes' => $scan->disk_total_bytes ? (int) $scan->disk_total_bytes : null,
                'images_tracked_bytes' => (int) ($notes['images_tracked_bytes'] ?? 0),
                'audio_tracked_bytes' => (int) ($notes['audio_tracked_bytes'] ?? 0),
            ],
            // Per-book / per-node cost, DATABASE ONLY — files are excluded
            // deliberately: a book's PDF says nothing about what its content
            // costs to store, and mixing them would make the number useless for
            // reasoning about quotas or about nodes_history bloat.
            'averages' => $this->averages($scan, $notes),
            'categories' => $categories,
            'top_books' => $this->topBooks($scan->id),
            'history' => $this->history(),
            // In prod the database is a MANAGED cluster — its bytes are not
            // droplet disk. The page keeps the two budgets visually separate.
            'db_is_managed' => str_contains((string) config('database.connections.pgsql.host'), 'ondigitalocean.com'),
            'db_limit_bytes' => config('storage.db_limit_bytes'),
        ]);
    }

    /**
     * GET /api/maintainer/storage/detail/{category} — the drill-down, biggest first.
     *
     * Every number here is a TOTAL for the category. Orphaned files are not
     * split out per row — they get their own section (see orphans()), because
     * mixing "how much is there" and "how much is garbage" in one row made both
     * numbers unreadable.
     */
    public function detail(string $category)
    {
        $scan = DB::table('storage_scans')->orderByDesc('id')->first();
        if (! $scan) {
            return response()->json(['rows' => []]);
        }

        // Database drills down by table; documents by file extension; the
        // book-shaped trees by book (which is what you act on).
        $groupBy = match ($category) {
            StorageScanner::DATABASE, StorageScanner::OTHER => 'subtype',
            StorageScanner::DOCUMENTS => 'subtype',
            default => 'book',
        };

        $byBook = $groupBy === 'book';

        $rows = DB::table('storage_scan_items')
            ->where('scan_id', $scan->id)
            ->where('category', $category)
            ->selectRaw("{$groupBy} AS label, SUM(bytes) AS bytes, SUM(file_count) AS file_count,
                         SUM(CASE WHEN is_orphan THEN bytes ELSE 0 END) AS orphan_bytes,
                         COUNT(DISTINCT book) AS book_count,
                         BOOL_OR(is_orphan) AS all_orphan,
                         MIN(owner) AS owner")
            ->groupBy($groupBy)
            ->orderByDesc('bytes')
            ->limit(200)
            ->get()
            // A file TYPE has no owner and is not itself orphaned — it spans
            // many books and many people. Only a row grouped BY BOOK can carry
            // an owner or an orphan flag; for the rest we report how much of
            // the type's bytes are orphaned, and across how many books.
            ->map(fn ($r) => [
                'label' => $r->label ?? '(unlabelled)',
                'bytes' => (int) $r->bytes,
                'file_count' => (int) $r->file_count,
                'orphan_bytes' => (int) $r->orphan_bytes,
                'book_count' => (int) $r->book_count,
                'is_orphan' => $byBook ? (bool) $r->all_orphan : false,
                'owner' => $byBook ? $r->owner : null,
            ]);

        return response()->json([
            'category' => $category,
            'grouped_by' => $byBook ? 'book' : ($category === StorageScanner::DATABASE ? 'table' : 'type'),
            'rows' => $rows,
        ]);
    }

    /**
     * GET /api/maintainer/storage/composition — what a node's bytes are MADE of.
     *
     * The per-book / per-node averages answer "how much"; this answers "of
     * what", and the answer is usually surprising: the prose is the small part.
     * Text is stored raw (a paragraph is under the ~2 KB TOAST threshold, so it
     * is never compressed), it is stored TWICE (content + plainText), and the
     * halfvec embedding still costs several times the text it describes (the
     * tsvectors live only in expression GIN indexes since 2026-08).
     *
     * Column shares come from a page-level SAMPLE, not a full scan:
     * sum(pg_column_size(col)) over every row means reading the whole table,
     * which is what made the first version of the table drill-down hang. The
     * sample gives proportions, which is all that is needed; those proportions
     * are then applied to the table's REAL size.
     */
    public function composition()
    {
        $db = DB::connection('pgsql_admin');

        $scanId = (int) (DB::table('storage_scans')->max('id') ?? 0);

        return response()->json(Cache::remember("storage.composition.{$scanId}", now()->addHour(), function () use ($db) {
            $size = $db->selectOne("
                SELECT pg_total_relation_size('nodes') AS total,
                       pg_relation_size('nodes')       AS heap,
                       pg_indexes_size('nodes')        AS indexes
            ");
            $toast = max(0, (int) $size->total - (int) $size->heap - (int) $size->indexes);

            // SYSTEM sampling reads whole pages — fast, and fine for shares.
            // NB: the tsvectors are no longer stored columns (2026-08 —
            // expression GIN indexes only), so their cost now lives entirely
            // in the "indexes" physical figure, not in any row column.
            $s = $db->selectOne('
                SELECT count(*) AS rows,
                       sum(pg_column_size(content))              AS content,
                       sum(pg_column_size("plainText"))          AS plaintext,
                       sum(pg_column_size(embedding))            AS embedding,
                       sum(pg_column_size(footnotes))            AS footnotes,
                       sum(pg_column_size(nodes.*))              AS row_total
                FROM nodes TABLESAMPLE SYSTEM (2)
            ');

            $nodeCount = (int) $db->table('nodes')->count();
            $sampled = max(1, (int) $s->rows);
            $rowTotal = max(1, (int) $s->row_total);

            $columns = [
                'embedding' => (int) $s->embedding,
                'content (HTML)' => (int) $s->content,
                'plainText (duplicate of content)' => (int) $s->plaintext,
                'footnotes' => (int) $s->footnotes,
            ];
            $columns['row overhead + small columns'] = max(0, $rowTotal - array_sum($columns));

            // TWO accounting systems, kept apart on purpose.
            //
            // LOGICAL = what each column's data costs, scaled from the sample by
            // row count. NOT apportioned against the heap: pg_column_size()
            // reports a value's stored size even when that value lives in TOAST,
            // so folding these into the heap and then listing TOAST separately
            // counts the same bytes twice. halfvec embeddings are ~1.5 KB each;
            // rows carrying one usually exceed the ~2 KB threshold, so they
            // are largely IN the TOAST figure below.
            //
            // PHYSICAL = how the table is laid out on disk. These three sum to
            // the table size; the logical column figures do not, and the two
            // lists must never be ranked against each other.
            $logical = [];
            foreach ($columns as $name => $sampleBytes) {
                $perNode = $sampleBytes / $sampled;
                $logical[] = [
                    'label' => $name,
                    'bytes' => (int) round($perNode * $nodeCount),
                    'per_node' => (int) round($perNode),
                    'share' => round(100 * $sampleBytes / $rowTotal, 1),
                    // Above the threshold it is compressed and moved out-of-line.
                    'toasted' => $perNode > 2000,
                ];
            }
            usort($logical, fn ($a, $z) => $z['bytes'] <=> $a['bytes']);

            return [
                'node_count' => $nodeCount,
                'sampled_rows' => $sampled,
                'physical' => [
                    'total' => (int) $size->total,
                    'heap' => (int) $size->heap,
                    'toast' => $toast,
                    'indexes' => (int) $size->indexes,
                ],
                'rows' => $logical,
                'note' => "per-column data cost, scaled from a {$sampled}-row page sample · "
                    . 'columns marked TOASTED are compressed and stored out-of-line, so they are counted '
                    . 'in the TOAST figure above rather than in the heap — the two lists are not addable',
            ];
        }));
    }

    /**
     * GET /api/maintainer/storage/users — footprint per user.
     *
     * Files come from the snapshot (every item carries the owner denormalised
     * at scan time — the seam built in for exactly this). The database half has
     * to be apportioned: there is no per-user byte figure, so a user's node
     * count is scaled by the table's real bytes-per-row. Both halves are
     * reported separately because they are different budgets — droplet disk vs
     * the managed cluster.
     *
     * Median as well as mean, because with one dominant user the mean describes
     * nobody: it is dragged up by the heaviest account while the typical user
     * sits far below it.
     */
    public function users()
    {
        $scan = DB::table('storage_scans')->orderByDesc('id')->first();
        if (! $scan) {
            return response()->json(['users' => [], 'stats' => null]);
        }

        $rows = Cache::remember("storage.users.{$scan->id}", now()->addHour(), function () use ($scan) {
            // Files: straight from the snapshot.
            $files = DB::table('storage_scan_items')
                ->where('scan_id', $scan->id)
                ->whereNotNull('owner')
                ->selectRaw('owner, SUM(bytes) AS bytes, COUNT(DISTINCT book) AS books')
                ->groupBy('owner')
                ->get()
                ->keyBy('owner');

            // Database: apportion the nodes table by each owner's share of rows.
            $nodesBytes = (int) DB::table('storage_scan_items')
                ->where('scan_id', $scan->id)
                ->where('category', StorageScanner::DATABASE)
                ->where('subtype', 'nodes')
                ->sum('bytes');

            $counts = DB::connection('pgsql_admin')->table('nodes as n')
                ->join('library as l', 'l.book', '=', 'n.book')
                ->whereNotNull('l.creator')
                ->selectRaw('l.creator AS owner, COUNT(*) AS nodes, COUNT(DISTINCT n.book) AS books')
                ->groupBy('l.creator')
                ->get();

            $totalNodes = max(1, (int) $counts->sum('nodes'));
            $bytesPerNode = $nodesBytes / $totalNodes;

            $byOwner = [];
            foreach ($counts as $c) {
                $byOwner[$c->owner] = [
                    'owner' => $c->owner,
                    'nodes' => (int) $c->nodes,
                    'books' => (int) $c->books,
                    'db_bytes' => (int) round($c->nodes * $bytesPerNode),
                    'file_bytes' => 0,
                ];
            }

            foreach ($files as $owner => $f) {
                $byOwner[$owner] ??= ['owner' => $owner, 'nodes' => 0, 'books' => (int) $f->books, 'db_bytes' => 0, 'file_bytes' => 0];
                $byOwner[$owner]['file_bytes'] = (int) $f->bytes;
                $byOwner[$owner]['books'] = max($byOwner[$owner]['books'], (int) $f->books);
            }

            return array_values(array_map(function (array $u) {
                $u['total_bytes'] = $u['db_bytes'] + $u['file_bytes'];
                // The per-book / per-node figures the heaviest account is the
                // useful test case for.
                $u['bytes_per_book'] = $u['books'] > 0 ? (int) round($u['total_bytes'] / $u['books']) : null;
                $u['bytes_per_node'] = $u['nodes'] > 0 ? (int) round($u['db_bytes'] / $u['nodes']) : null;

                return $u;
            }, $byOwner));
        });

        usort($rows, fn ($a, $z) => $z['total_bytes'] <=> $a['total_bytes']);

        return response()->json([
            'users' => array_slice($rows, 0, 100),
            'stats' => $this->userStats($rows),
        ]);
    }

    /**
     * Mean AND median. With one heavy user the mean is misleading — it
     * describes an account nobody has — so the median is what to design quotas
     * around, and the gap between them is itself the signal.
     *
     * @param  array<int, array<string, mixed>>  $rows
     */
    private function userStats(array $rows): array
    {
        $totals = array_values(array_filter(array_column($rows, 'total_bytes')));
        sort($totals);
        $n = count($totals);

        $median = $n === 0 ? 0 : ($n % 2
            ? $totals[intdiv($n, 2)]
            : (int) round(($totals[$n / 2 - 1] + $totals[$n / 2]) / 2));

        return [
            'user_count' => $n,
            'total_bytes' => array_sum($totals),
            'mean_bytes' => $n > 0 ? (int) round(array_sum($totals) / $n) : 0,
            'median_bytes' => $median,
            'largest_bytes' => $n > 0 ? $totals[$n - 1] : 0,
        ];
    }

    /**
     * GET /api/maintainer/storage/deleted-content — books marked `deleted` that
     * are still holding nodes.
     *
     * Invisible to the orphan sweep, which looks for a MISSING library row;
     * these rows exist and say `deleted`. Root books and sub-books are reported
     * SEPARATELY on purpose: sub-book content is preserved deliberately (so
     * highlights pointing into footnote sub-books survive), and lumping them
     * together reads as hundreds of problems when there are only a couple.
     */
    public function deletedContent()
    {
        $db = DB::connection('pgsql_admin');

        $base = fn (bool $subBooks) => $db->table('nodes as n')
            ->join('library as l', 'l.book', '=', 'n.book')
            ->where('l.visibility', 'deleted')
            ->where('n.book', $subBooks ? 'like' : 'not like', '%/%');

        $rootRows = (clone $base(false))
            ->selectRaw('n.book, COUNT(*) AS nodes, MIN(n.created_at) AS first_written, MAX(l.updated_at) AS deleted_at')
            ->groupBy('n.book')
            ->orderByDesc('nodes')
            ->limit(50)
            ->get()
            ->map(fn ($r) => [
                'label' => $r->book,
                'file_count' => (int) $r->nodes,
                'bytes' => 0,   // rows, not bytes — the page labels this column
                'written_after_delete' => $r->first_written > $r->deleted_at,
                'owner' => null,
                'is_orphan' => true,
                'orphan_bytes' => 0,
                'book_count' => 1,
            ]);

        $subTotals = (clone $base(true))->selectRaw('COUNT(DISTINCT n.book) AS books, COUNT(*) AS nodes')->first();

        return response()->json([
            'root' => [
                'books' => $rootRows->count(),
                'nodes' => (int) $rootRows->sum('file_count'),
                'rows' => $rootRows,
            ],
            // Reported, never flagged: this is intended behaviour.
            'sub_books' => [
                'books' => (int) ($subTotals->books ?? 0),
                'nodes' => (int) ($subTotals->nodes ?? 0),
                'note' => 'preserved on purpose so highlights into footnote sub-books survive their parent',
            ],
        ]);
    }

    /**
     * GET /api/maintainer/storage/orphans — the files whose book no longer
     * exists, as their OWN list rather than a flag mixed into the category
     * views. One row per orphaned book, biggest first, with the path so it can
     * be matched against what `storage:reclaim` reports.
     */
    public function orphans()
    {
        $scan = DB::table('storage_scans')->orderByDesc('id')->first();
        if (! $scan) {
            return response()->json(['rows' => [], 'total_bytes' => 0]);
        }

        $rows = DB::table('storage_scan_items')
            ->where('scan_id', $scan->id)
            ->where('is_orphan', true)
            ->selectRaw("book, SUM(bytes) AS bytes, SUM(file_count) AS file_count,
                         COUNT(DISTINCT category) AS category_count,
                         STRING_AGG(DISTINCT category, ', ' ORDER BY category) AS categories,
                         MIN(path) AS path")
            ->groupBy('book')
            ->orderByDesc('bytes')
            ->limit(200)
            ->get()
            ->map(fn ($r) => [
                'label' => $r->book,
                'bytes' => (int) $r->bytes,
                'file_count' => (int) $r->file_count,
                'categories' => $r->categories,
                'path' => $r->path,
                'owner' => null,
                'is_orphan' => true,
                'orphan_bytes' => (int) $r->bytes,
                'book_count' => 1,
            ]);

        return response()->json([
            'rows' => $rows,
            'total_bytes' => (int) $scan->orphan_bytes,
            'book_count' => $rows->count(),
        ]);
    }

    /**
     * GET /api/maintainer/storage/table/{table} — which books are biggest
     * INSIDE one database table (click `nodes`, see the books filling it).
     *
     * The snapshot only holds per-table totals, so this measures live:
     * SUM(pg_column_size(row)) needs a full scan, which is why it is on-demand
     * (a deliberate click, not the nightly scan) with a statement timeout and
     * an hour of caching. Tables with no `book` column say so rather than
     * pretending.
     */
    public function table(string $table)
    {
        $db = DB::connection('pgsql_admin');

        // Whitelist from the catalog — the name goes into raw SQL.
        $known = $db->table('pg_class as c')
            ->join('pg_namespace as n', 'n.oid', '=', 'c.relnamespace')
            ->where('n.nspname', 'public')->where('c.relkind', 'r')
            ->pluck('c.relname')->all();

        if (! in_array($table, $known, true)) {
            return response()->json(['message' => 'Unknown table.'], 404);
        }

        $hasBook = $db->table('information_schema.columns')
            ->where('table_schema', 'public')->where('table_name', $table)
            ->where('column_name', 'book')->exists();

        if (! $hasBook) {
            return response()->json([
                'table' => $table,
                'per_book' => false,
                'message' => "{$table} has no book column — its rows aren't attributable to a book.",
                'rows' => [],
            ]);
        }

        // Key the cache to the LATEST SCAN, not to a clock. A purge + vacuum can
        // change a table by an order of magnitude in minutes, and an hour-long
        // key kept serving pre-purge numbers (nodes_history showed 2.4 GB for a
        // book whose rows were already gone). A new scan means the world moved:
        // new key, fresh measurement.
        $scanId = DB::table('storage_scans')->max('id') ?? 0;

        $result = Cache::remember("storage.table.{$table}.{$scanId}", now()->addHour(), function () use ($db, $table) {
            // Byte-exact attribution (SUM(pg_column_size(row))) means a full
            // scan — on prod's nodes_history that is 12 GB / 10M rows and never
            // returns inside a web request. So: count rows per book (an index
            // scan) and apportion the table's real size by row share. Labelled
            // as an estimate on screen, because it is one.
            //
            // The timeout MUST be inside a transaction: `SET LOCAL` outside one
            // is silently a no-op, which is how the unbounded version shipped.
            $meta = $db->selectOne('
                SELECT pg_total_relation_size(c.oid) AS total_bytes,
                       GREATEST(c.reltuples, 1) AS est_rows
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = \'public\' AND c.relname = ?
            ', [$table]);

            $bytesPerRow = ((float) $meta->total_bytes) / ((float) $meta->est_rows);

            // 1. Exact counts, bounded. The timeout MUST live inside a
            // transaction — `SET LOCAL` outside one is silently a no-op, which
            // is how an unbounded version shipped and hung on a 12 GB table.
            try {
                $db->beginTransaction();
                $db->statement("SET LOCAL statement_timeout = '8s'");
                $counts = $db->select("
                    SELECT t.book, COUNT(*) AS row_count
                    FROM {$table} t
                    GROUP BY t.book
                    ORDER BY row_count DESC
                    LIMIT 25
                ");
                $db->rollBack();

                return [
                    'method' => 'exact row counts',
                    'rows' => array_map(fn ($r) => [
                        'book' => $r->book,
                        'row_count' => (int) $r->row_count,
                        'bytes' => (int) round($r->row_count * $bytesPerRow),
                    ], $counts),
                ];
            } catch (\Throwable $e) {
                // Cancelled by the timeout on a very large table. Not an error
                // the operator should see as a 500 — fall through.
                $db->rollBack();
            }

            // 2. Planner statistics: the most common `book` values and their
            // frequencies, straight from ANALYZE. No scan, instant, approximate
            // — and the only thing that answers this on a 10M-row history table.
            $stats = $db->selectOne("
                SELECT most_common_vals::text::text[] AS vals, most_common_freqs AS freqs
                FROM pg_stats
                WHERE schemaname = 'public' AND tablename = ? AND attname = 'book'
            ", [$table]);

            if (! $stats || ! $stats->vals) {
                return ['method' => 'unavailable', 'rows' => []];
            }

            $vals = str_getcsv(trim($stats->vals, '{}'));
            $freqs = array_map('floatval', explode(',', trim((string) $stats->freqs, '{}')));
            $estRows = (float) $meta->est_rows;

            $rows = [];
            foreach ($vals as $i => $book) {
                $share = $freqs[$i] ?? 0;
                $rowCount = (int) round($share * $estRows);
                $rows[] = [
                    'book' => $book,
                    'row_count' => $rowCount,
                    'bytes' => (int) round($rowCount * $bytesPerRow),
                ];
            }
            usort($rows, fn ($a, $b) => $b['bytes'] <=> $a['bytes']);

            return ['method' => 'planner statistics (approximate — table too large to count live)',
                'rows' => array_slice($rows, 0, 25)];
        });

        $rows = $result['rows'];

        $owners = DB::connection('pgsql_admin')->table('library')
            ->whereIn('book', array_column($rows, 'book'))
            ->pluck('creator', 'book');

        return response()->json([
            'table' => $table,
            'per_book' => true,
            'note' => $result['method'] === 'unavailable'
                ? "{$table} is too large to attribute live, and has no planner statistics for its book column (run ANALYZE {$table})."
                // Say which scan this is pinned to, so a stale number is
                // identifiable rather than merely wrong.
                : "sizes estimated by row share of the table total · {$result['method']} · scan #{$scanId}",
            'rows' => array_map(fn ($r) => [
                'label' => $r['book'],
                'bytes' => $r['bytes'],
                'file_count' => $r['row_count'],
                'owner' => $owners[$r['book']] ?? null,
                'orphan_bytes' => 0,
                'book_count' => 1,
                'is_orphan' => false,
            ], $rows),
        ]);
    }

    /**
     * GET /api/maintainer/storage/type/{category}/{subtype} — which books hold
     * the most of one file type (click `pdf`, see whose PDFs they are).
     * Straight from the snapshot, no live measurement needed.
     */
    public function type(string $category, string $subtype)
    {
        $scan = DB::table('storage_scans')->orderByDesc('id')->first();
        if (! $scan) {
            return response()->json(['rows' => []]);
        }

        $rows = DB::table('storage_scan_items')
            ->where('scan_id', $scan->id)
            ->where('category', $category)
            ->where('subtype', $subtype)
            ->whereNotNull('book')
            ->selectRaw('book, owner, SUM(bytes) AS bytes, SUM(file_count) AS file_count, BOOL_OR(is_orphan) AS is_orphan')
            ->groupBy('book', 'owner')
            ->orderByDesc('bytes')
            ->limit(50)
            ->get()
            ->map(fn ($r) => [
                'label' => $r->book,
                'bytes' => (int) $r->bytes,
                'file_count' => (int) $r->file_count,
                'owner' => $r->owner,
                'is_orphan' => (bool) $r->is_orphan,
                'orphan_bytes' => 0,
                'book_count' => 1,
            ]);

        return response()->json(['category' => $category, 'subtype' => $subtype, 'rows' => $rows]);
    }

    /**
     * GET /api/maintainer/storage/export — the whole snapshot as a JSON file.
     *
     * Every row, not the page's top-N truncations: the point is to pull prod's
     * numbers onto a dev machine and slice them properly (jq, a notebook, or
     * Claude) rather than squint at a dashboard.
     */
    public function export()
    {
        $scan = DB::table('storage_scans')->orderByDesc('id')->first();
        if (! $scan) {
            return response()->json(['message' => 'No snapshot yet — run a scan first.'], 404);
        }

        $items = DB::table('storage_scan_items')
            ->where('scan_id', $scan->id)
            ->orderByDesc('bytes')
            ->get(['book', 'owner', 'category', 'subtype', 'bytes', 'file_count', 'path', 'is_orphan']);

        $payload = [
            'scan' => $scan,
            'environment' => [
                'app_env' => config('app.env'),
                'app_url' => config('app.url'),
                'db_is_managed' => str_contains((string) config('database.connections.pgsql.host'), 'ondigitalocean.com'),
                'roots' => StorageScanner::roots(),
            ],
            'history' => $this->history(),
            'items' => $items,
        ];

        $name = "storage-scan-{$scan->id}-" . str_replace([' ', ':'], ['_', ''], (string) $scan->finished_at) . '.json';

        return response()->streamDownload(
            fn () => print(json_encode($payload, JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE)),
            $name,
            ['Content-Type' => 'application/json'],
        );
    }

    /** POST /api/maintainer/storage/rescan — measure now (~2s), then hand back the new summary. */
    public function rescan()
    {
        // "Rescan" has to mean EVERYTHING on the page, not just the snapshot.
        // The per-table drill-downs are measured live and cached, so a rescan
        // that only rewrote the snapshot left them serving pre-purge numbers —
        // nodes_history kept showing 2.4 GB for a book whose rows were already
        // deleted. Keying those caches to the scan id fixes it on its own; this
        // clears them outright so freshness never depends on that subtlety.
        $this->forgetTableCaches();

        $exit = Artisan::call('storage:scan');
        if ($exit !== 0) {
            return response()->json(['message' => 'Scan failed — see logs.'], 422);
        }

        // Again after the scan: the id has moved, and anything measured during
        // the scan window is now stale too.
        $this->forgetTableCaches();

        return $this->summary();
    }

    /** Drop every cached live table measurement, across recent scan ids. */
    private function forgetTableCaches(): void
    {
        $tables = DB::connection('pgsql_admin')->table('pg_class as c')
            ->join('pg_namespace as n', 'n.oid', '=', 'c.relnamespace')
            ->where('n.nspname', 'public')->where('c.relkind', 'r')
            ->pluck('c.relname');

        $latest = (int) (DB::table('storage_scans')->max('id') ?? 0);

        foreach ($tables as $table) {
            // A couple of ids back as well — cheap, and covers a key written
            // between the flush and the new snapshot landing.
            for ($id = max(0, $latest - 2); $id <= $latest + 1; $id++) {
                Cache::forget("storage.table.{$table}.{$id}");
            }
        }
    }

    /**
     * Average database cost per book and per node.
     *
     * Database only. A book's PDF or audio says nothing about what its CONTENT
     * costs, and blending them would hide the thing these numbers are for:
     * spotting when the per-node cost climbs because history is accumulating.
     *
     * Two per-node figures on purpose — `nodes` alone is what a node genuinely
     * costs; including `nodes_history` shows what the archive adds on top. On
     * production that gap was the 12 GB of ranking-book history.
     */
    private function averages(object $scan, array $notes): array
    {
        $books = (int) ($notes['book_count_root'] ?? 0);
        $nodes = (int) ($notes['node_count'] ?? 0);

        if ($books === 0 && $nodes === 0) {
            return ['available' => false];   // pre-dates these counts
        }

        $tableBytes = fn (string $t) => (int) DB::table('storage_scan_items')
            ->where('scan_id', $scan->id)
            ->where('category', StorageScanner::DATABASE)
            ->where('subtype', $t)
            ->sum('bytes');

        $nodesBytes = $tableBytes('nodes');
        $historyBytes = $tableBytes('nodes_history');

        return [
            'available' => true,
            'book_count' => $books,
            'book_count_all' => (int) ($notes['book_count_all'] ?? 0),
            'node_count' => $nodes,
            'db_bytes' => (int) $scan->db_bytes,
            'bytes_per_book' => $books > 0 ? (int) round($scan->db_bytes / $books) : null,
            'nodes_per_book' => $books > 0 ? round($nodes / $books, 1) : null,
            'bytes_per_node' => $nodes > 0 ? (int) round($nodesBytes / $nodes) : null,
            'bytes_per_node_with_history' => $nodes > 0 ? (int) round(($nodesBytes + $historyBytes) / $nodes) : null,
        ];
    }

    /** Biggest books across every file category — the "who is using the space" list. */
    private function topBooks(int $scanId): array
    {
        return DB::table('storage_scan_items')
            ->where('scan_id', $scanId)
            ->whereNotNull('book')
            ->selectRaw('book, MIN(owner) AS owner, SUM(bytes) AS bytes, BOOL_OR(is_orphan) AS is_orphan')
            ->groupBy('book')
            ->orderByDesc('bytes')
            ->limit(25)
            ->get()
            ->map(fn ($r) => [
                'book' => $r->book,
                'owner' => $r->owner,
                'bytes' => (int) $r->bytes,
                'is_orphan' => (bool) $r->is_orphan,
            ])
            ->all();
    }

    /** Growth over time — the reason snapshots are kept rather than measured live. */
    private function history(): array
    {
        return DB::table('storage_scans')
            ->orderByDesc('id')
            ->limit(30)
            ->get(['finished_at', 'total_bytes', 'db_bytes', 'file_bytes', 'orphan_bytes'])
            ->reverse()
            ->values()
            ->map(fn ($r) => [
                'at' => $r->finished_at,
                'total_bytes' => (int) $r->total_bytes,
                'db_bytes' => (int) $r->db_bytes,
                'file_bytes' => (int) $r->file_bytes,
                'orphan_bytes' => (int) $r->orphan_bytes,
            ])
            ->all();
    }
}
