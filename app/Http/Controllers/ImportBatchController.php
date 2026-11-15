<?php

namespace App\Http\Controllers;

use App\Models\ImportBatch;
use App\Models\ImportItem;
use App\Services\DocumentImport\ImportBatches;
use App\Services\DocumentImport\VaultBookResolver;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * Import batches: the API behind the import-queue widget. Thin HTTP layer —
 * the logic lives in App\Services\DocumentImport\ImportBatches.
 *
 * All routes sit inside the authed `author` group; ownership checks are RLS
 * itself: a lookup/update of someone else's batch matches zero rows → 404.
 */
class ImportBatchController extends Controller
{
    public function __construct(private ImportBatches $batches, private VaultBookResolver $resolver)
    {
    }

    /**
     * POST /api/import-batches/resolve — the folder-drop pre-flight: which of
     * these notes are ALREADY books in Hyperlit that the caller can read?
     * Read-only. A vault exported from Hyperlit names each note's original
     * book (`book:` / `hyperlit:` front matter); any vault may carry DOIs.
     * The client then asks ONCE whether to shelve the existing books or import
     * the user's own versions. A book the caller cannot read comes back `new`,
     * the same as one that does not exist (see VaultBookResolver).
     */
    public function resolve(Request $request)
    {
        $validated = $request->validate([
            'items' => 'required|array|min:1|max:300',
            'items.*.key' => 'required|string|max:64',
            'items.*.book' => 'nullable|string|max:255',
            'items.*.hyperlit_url' => 'nullable|string|max:2048',
            'items.*.doi' => 'nullable|string|max:255',
            'items.*.title' => 'nullable|string|max:1000',
        ]);

        $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);
        if (empty($creatorInfo['valid'])) {
            return response()->json(['message' => 'No valid session'], 401);
        }

        return response()->json([
            'results' => $this->resolver->resolve(
                $validated['items'],
                Auth::user(),
                Auth::check() ? null : $request->cookie('anon_token'),
            ),
        ]);
    }

    /**
     * POST /api/import-batches — create a batch + items (pending_upload)
     * before any file bytes move, so the widget shows the whole queue
     * immediately. Optionally creates the auto-shelf, OR appends to an
     * EXISTING shelf via `shelf_id` (the maintainer shelf-import drop
     * target). The two are mutually exclusive.
     *
     * `existing_books` are books ALREADY in Hyperlit that belong on the shelf
     * as they are — no upload, no import (a re-imported export; see resolve()).
     * Each id is re-checked for readability HERE: the shelf append runs on
     * pgsql_admin, so this is the only thing stopping a forged id from putting
     * a book the caller cannot read onto their shelf. With no `items` at all
     * nothing is registered as a batch — the call only shelves, and `id` is null.
     *
     * shelf_id is authorized HERE and nowhere else: the completion-time
     * append (ImportBatches::onJobTerminal → HarvestShelf::addBooks) runs
     * on pgsql_admin and bypasses shelf_items RLS, so this check is the
     * security gate. Allowed: admins (any shelf — system-owned archive
     * shelves included) or the shelf's own creator. Everyone else gets the
     * same 404 an unknown uuid gets, so shelf existence doesn't leak.
     */
    public function store(Request $request)
    {
        $validated = $request->validate([
            'label' => 'required|string|max:255',
            'source' => 'required|string|in:files,folder,vault',
            'auto_shelf' => 'boolean',
            'shelf_id' => 'nullable|uuid',
            'items' => 'required_without:existing_books|array|max:100',
            // A single upload that turned out to be a book already in Hyperlit:
            // file it on the caller's private "Imported works" shelf — the
            // same place a DOI import of an existing work lands.
            'imports_shelf' => 'boolean',
            'existing_books' => 'nullable|array|max:300',
            'existing_books.*' => 'string|max:255|regex:/^[a-zA-Z0-9_-]+$/',
            'items.*.book' => 'required|string|max:255|regex:/^[a-zA-Z0-9_-]+$/',
            'items.*.title' => 'nullable|string|max:255',
            'items.*.filename' => 'nullable|string|max:255',
        ]);

        $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);
        if (empty($creatorInfo['valid'])) {
            return response()->json(['message' => 'No valid session'], 401);
        }

        $explicitShelf = null;
        if (!empty($validated['shelf_id'])) {
            if (!empty($validated['auto_shelf'])) {
                return response()->json(['message' => 'auto_shelf and shelf_id are mutually exclusive'], 422);
            }

            // pgsql_admin: the target may be a system-owned shelf invisible
            // to the caller's RLS context — authorization is explicit below.
            $shelf = DB::connection('pgsql_admin')->table('shelves')
                ->where('id', $validated['shelf_id'])
                ->first(['id', 'name', 'slug', 'creator', 'kind']);

            // Derived shelves have ONE writer each: Likes mirrors book_likes,
            // licence-review is rebuilt by library:licence-review. An import
            // appended to either would be a row nothing else knows about.
            if ($shelf && in_array($shelf->kind ?? null, [
                \App\Services\Shelves\LikesShelf::KIND,
                \App\Services\Shelves\LicenceReviewShelf::KIND,
            ], true)) {
                return response()->json(['message' => 'Books can\'t be imported straight onto this shelf.'], 422);
            }

            $allowed = $shelf && (
                (Auth::user()?->isAdmin() ?? false)
                || $shelf->creator === ($creatorInfo['creator'] ?? null)
            );
            if (!$allowed) {
                return response()->json(['message' => 'Shelf not found'], 404);
            }

            $explicitShelf = ['id' => $shelf->id, 'name' => $shelf->name, 'slug' => $shelf->slug];
        }

        if ($explicitShelf === null && !empty($validated['imports_shelf']) && empty($validated['auto_shelf'])
            && !empty($creatorInfo['creator'])) {
            // Owned by the caller by construction (keyed on their creator name),
            // so no further authorization is needed.
            $imports = app(\App\Services\SourceHarvest\HarvestShelf::class)->ensureImportShelfFor($creatorInfo['creator']);
            $explicitShelf = ['id' => $imports->id, 'name' => $imports->name, 'slug' => $imports->slug];
        }

        $existing = [];
        foreach (array_unique($validated['existing_books'] ?? []) as $bookId) {
            if ($this->resolver->readableBook($bookId)) {
                $existing[] = $bookId;
            }
        }

        $result = $this->batches->createBatch(
            $validated['items'] ?? [],
            $validated['label'],
            $validated['source'],
            (bool) ($validated['auto_shelf'] ?? false),
            $creatorInfo,
            Auth::id(),
            $explicitShelf,
            $existing,
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
