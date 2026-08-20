<?php

namespace App\Http\Controllers;

use App\Models\ImportBatch;
use App\Models\ImportItem;
use App\Services\DocumentImport\ImportBatches;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

/**
 * Import batches: the API behind the import-queue widget. Thin HTTP layer —
 * the logic lives in App\Services\DocumentImport\ImportBatches.
 *
 * All routes sit inside the authed `author` group; ownership checks are RLS
 * itself: a lookup/update of someone else's batch matches zero rows → 404.
 */
class ImportBatchController extends Controller
{
    public function __construct(private ImportBatches $batches)
    {
    }

    /**
     * POST /api/import-batches — create a batch + items (pending_upload)
     * before any file bytes move, so the widget shows the whole queue
     * immediately. Optionally creates the auto-shelf.
     */
    public function store(Request $request)
    {
        $validated = $request->validate([
            'label' => 'required|string|max:255',
            'source' => 'required|string|in:files,folder,vault',
            'auto_shelf' => 'boolean',
            'items' => 'required|array|min:1|max:100',
            'items.*.book' => 'required|string|max:255|regex:/^[a-zA-Z0-9_-]+$/',
            'items.*.title' => 'nullable|string|max:255',
            'items.*.filename' => 'nullable|string|max:255',
        ]);

        $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);
        if (empty($creatorInfo['valid'])) {
            return response()->json(['message' => 'No valid session'], 401);
        }

        $result = $this->batches->createBatch(
            $validated['items'],
            $validated['label'],
            $validated['source'],
            (bool) ($validated['auto_shelf'] ?? false),
            $creatorInfo,
            Auth::id(),
        );

        return response()->json($result, 201);
    }

    /**
     * GET /api/my-imports — the widget's single aggregate poll. Named
     * `import-progress` limiter (own bucket; see AppServiceProvider).
     */
    public function index()
    {
        return response()->json($this->batches->aggregateFor());
    }

    /** POST /api/import-batches/{id}/notify — batch-level "email me when done". */
    public function notify(string $id)
    {
        if (!Auth::id()) {
            // Anonymous authors have no email address to notify.
            return response()->json(['message' => 'Sign in to get email notifications'], 422);
        }

        $updated = ImportBatch::where('id', $id)
            ->update(['notify_email' => true, 'user_id' => Auth::id(), 'updated_at' => now()]);
        if ($updated === 0) {
            return response()->json(['message' => 'Batch not found'], 404);
        }

        return response()->json(['ok' => true]);
    }

    /** POST /api/import-batches/{id}/dismiss — drop the batch from /my-imports. */
    public function dismiss(string $id)
    {
        $updated = ImportBatch::where('id', $id)
            ->update(['dismissed_at' => now(), 'updated_at' => now()]);
        if ($updated === 0) {
            return response()->json(['message' => 'Batch not found'], 404);
        }

        return response()->json(['ok' => true]);
    }

    /**
     * PATCH /api/import-batches/{id}/items/{book} — the uploader reports a
     * client-side upload failure. Only pending_upload → upload_failed is a
     * legal transition here; everything else is worker-owned.
     */
    public function updateItem(Request $request, string $id, string $book)
    {
        $validated = $request->validate([
            'status' => 'required|string|in:upload_failed',
            'error' => 'nullable|string|max:2000',
        ]);

        $updated = ImportItem::where('batch_id', $id)
            ->where('book', $book)
            ->where('status', 'pending_upload')
            ->update([
                'status' => $validated['status'],
                'error' => $validated['error'] ?? null,
                'updated_at' => now(),
            ]);
        if ($updated === 0) {
            return response()->json(['message' => 'Item not found or not pending'], 404);
        }

        return response()->json(['ok' => true]);
    }
}
