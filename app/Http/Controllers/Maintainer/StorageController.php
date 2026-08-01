<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Services\Storage\StorageScanner;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
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

    /** GET /api/maintainer/storage/detail/{category} — the drill-down, biggest first. */
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

        $rows = DB::table('storage_scan_items')
            ->where('scan_id', $scan->id)
            ->where('category', $category)
            ->selectRaw("{$groupBy} AS label, SUM(bytes) AS bytes, SUM(file_count) AS file_count,
                         BOOL_OR(is_orphan) AS is_orphan, MIN(owner) AS owner")
            ->groupBy($groupBy)
            ->orderByDesc('bytes')
            ->limit(200)
            ->get()
            ->map(fn ($r) => [
                'label' => $r->label ?? '(unlabelled)',
                'bytes' => (int) $r->bytes,
                'file_count' => (int) $r->file_count,
                'is_orphan' => (bool) $r->is_orphan,
                'owner' => $r->owner,
            ]);

        // For book-shaped categories, also break the SAME category down by
        // extension where we have it, so "documents" answers both questions.
        return response()->json([
            'category' => $category,
            'grouped_by' => $groupBy === 'subtype' ? ($category === StorageScanner::DATABASE ? 'table' : 'type') : 'book',
            'rows' => $rows,
        ]);
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
