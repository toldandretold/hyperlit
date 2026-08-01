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

        $rows = Cache::remember("storage.table.{$table}", now()->addHour(), function () use ($db, $table) {
            // Byte-exact attribution (SUM(pg_column_size(row))) means a full
            // scan — on prod's nodes_history that is 12 GB / 10M rows and never
            // returns inside a web request. So: count rows per book (an index
            // scan) and apportion the table's real size by row share. Labelled
            // as an estimate on screen, because it is one.
            //
            // The timeout MUST be inside a transaction: `SET LOCAL` outside one
            // is silently a no-op, which is how the unbounded version shipped.
            $db->beginTransaction();

            try {
                $db->statement("SET LOCAL statement_timeout = '20s'");

                $meta = $db->selectOne('
                    SELECT pg_total_relation_size(c.oid) AS total_bytes,
                           GREATEST(c.reltuples, 1) AS est_rows
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = \'public\' AND c.relname = ?
                ', [$table]);

                $counts = $db->select("
                    SELECT t.book, COUNT(*) AS row_count
                    FROM {$table} t
                    GROUP BY t.book
                    ORDER BY row_count DESC
                    LIMIT 25
                ");

                $db->rollBack();
            } catch (\Throwable $e) {
                $db->rollBack();
                throw $e;
            }

            $bytesPerRow = ((float) $meta->total_bytes) / ((float) $meta->est_rows);

            return array_map(fn ($r) => (object) [
                'book' => $r->book,
                'row_count' => (int) $r->row_count,
                'bytes' => (int) round($r->row_count * $bytesPerRow),
            ], $counts);
        });

        $owners = DB::connection('pgsql_admin')->table('library')
            ->whereIn('book', array_map(fn ($r) => $r->book, $rows))
            ->pluck('creator', 'book');

        return response()->json([
            'table' => $table,
            'per_book' => true,
            'note' => 'estimated by row share of the table total — exact byte attribution needs a full scan',
            'rows' => array_map(fn ($r) => [
                'label' => $r->book,
                'bytes' => (int) $r->bytes,
                'file_count' => (int) $r->row_count,
                'owner' => $owners[$r->book] ?? null,
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
        $exit = Artisan::call('storage:scan');
        if ($exit !== 0) {
            return response()->json(['message' => 'Scan failed — see logs.'], 422);
        }

        return $this->summary();
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
