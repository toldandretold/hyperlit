<?php

namespace App\Http\Controllers;

use App\Models\Shelf;
use App\Models\ShelfItem;
use App\Models\ShelfPin;
use App\Services\Connections\ConnectionCountQuery;
use App\Services\Connections\ConnectionRefresher;
use App\Services\EmbeddingService;
use App\Services\LibraryCardGenerator;
use App\Services\SearchService;
use App\Services\ShelfCacheInvalidator;
use App\Services\Shelves\LicenceReviewShelf;
use App\Services\Shelves\LikesShelf;
use App\Services\Shelves\ShelfKinds;
use App\Services\Stats\ReadStatsCounter;
use Carbon\Carbon;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * The `shelves` (+ `shelf_items`) API — user-curated book collections. The list/create responses
 * must stay in sync with the TS contract `Shelf` (`components/shelves/types.ts`); `creator_token`
 * is set null server-side and never sent. `render`/`publicRender` build a SYNTHETIC book (nodes)
 * from the shelf's items, so those return a `bookId` the reader then loads via the normal content path.
 */
class ShelfController extends Controller
{
    /**
     * Generate a unique slug for a shelf, scoped to the creator.
     * Delegates to ShelfSlug — shared with HarvestShelf (the Source Network
     * Harvester's server-side shelf creation) so the algorithm can't drift.
     */
    private function generateUniqueSlug(string $name, string $creator, ?string $excludeId = null): string
    {
        return \App\Services\ShelfSlug::unique($name, $creator, $excludeId);
    }

    /**
     * List current user's shelves — the LOAD shape for the TS `Shelf[]` (`GET /api/shelves`).
     * Pass ?book=<id> to also receive an `is_member` boolean per shelf.
     *
     * @return \Illuminate\Http\JsonResponse array{shelves: array<int, array{
     *   id: string, name: string, slug: string, description: ?string, visibility: string,
     *   default_sort: string, created_at: string, updated_at: string, item_count: int, is_member?: bool
     * }>}
     */
    public function index(Request $request)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $bookId = $request->query('book');

        $columns = [
            'shelves.id',
            'shelves.name',
            'shelves.slug',
            'shelves.description',
            'shelves.visibility',
            'shelves.default_sort',
            // 'user' | 'likes'. Shipped in the list so the client can tell the
            // system shelf apart — the add-to-shelf menu hides it (its
            // membership comes from liking, not from a checkbox) while the
            // profile/tabs treat it as any other shelf.
            'shelves.kind',
            // The member book nominated as the shelf's overview (ShelfOverview).
            'shelves.overview_book',
            'shelves.created_at',
            'shelves.updated_at',
            // item_count used by the AI Brain shelf picker to refuse submit on empty shelves
            DB::raw('(SELECT COUNT(*) FROM shelf_items WHERE shelf_items.shelf_id = shelves.id) AS item_count'),
        ];

        $query = DB::table('shelves')->where('shelves.creator', $user->name);

        if ($bookId) {
            $query->leftJoin('shelf_items', function ($j) use ($bookId) {
                $j->on('shelf_items.shelf_id', '=', 'shelves.id')
                  ->where('shelf_items.book', '=', $bookId);
            });
            $columns[] = DB::raw('(shelf_items.shelf_id IS NOT NULL) as is_member');
        }

        $shelves = $query->orderByDesc('shelves.updated_at')->get($columns);

        // Where each shelf opens (the add-to-shelf menu's arrow): its archive
        // page — the shelf's "home page" — when it has one and is public (a
        // private shelf's /a/ page shows nothing), else the shelf on the
        // owner's user page.
        $archiveSlugs = \App\Models\ArchiveSource::whereIn('shelf_id', $shelves->pluck('id'))->pluck('slug', 'shelf_id');
        foreach ($shelves as $shelf) {
            $shelf->url = ($shelf->visibility === 'public' && isset($archiveSlugs[$shelf->id]))
                ? url('/a/' . $archiveSlugs[$shelf->id])
                : \App\Support\UsernameKey::shelfUrl($user->name, $shelf->slug ?: $shelf->id);
        }

        return response()->json(['shelves' => $shelves]);
    }

    /**
     * Create a new shelf (owner = current user; `creator_token` null; unique name + slug per creator).
     *
     * @return \Illuminate\Http\JsonResponse array{success: true, shelf: array{
     *   id: string, name: string, slug: string, description: ?string, visibility: string, default_sort: string
     * }} | array{error: string}
     */
    public function store(Request $request)
    {
        $request->validate([
            'name' => 'required|string|max:255',
            'description' => 'nullable|string',
            'visibility' => 'nullable|string|in:private,public',
            'default_sort' => 'nullable|string|in:recent,views,added,manual',
        ]);

        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        // Check for duplicate name
        $exists = DB::table('shelves')
            ->where('creator', $user->name)
            ->where('name', $request->name)
            ->exists();

        if ($exists) {
            return response()->json(['error' => 'A shelf with that name already exists'], 422);
        }

        $slug = $this->generateUniqueSlug($request->name, $user->name);

        $id = DB::connection('pgsql_admin')->table('shelves')->insertGetId([
            'creator' => $user->name,
            'creator_token' => null,
            'name' => $request->name,
            'slug' => $slug,
            'description' => $request->description,
            'visibility' => $request->visibility ?? 'private',
            'default_sort' => $request->default_sort ?? 'recent',
            'created_at' => now(),
            'updated_at' => now(),
        ], 'id');

        return response()->json([
            'success' => true,
            'shelf' => [
                'id' => $id,
                'name' => $request->name,
                'slug' => $slug,
                'description' => $request->description,
                'visibility' => $request->visibility ?? 'private',
                'default_sort' => $request->default_sort ?? 'recent',
            ],
        ], 201);
    }

    /**
     * Update a shelf (rename, visibility, default_sort) — owner-only. @return array{success: true}|array{error: string}
     */
    public function update(Request $request, string $id)
    {
        $request->validate([
            'name' => 'nullable|string|max:255',
            'description' => 'nullable|string',
            'visibility' => 'nullable|string|in:private,public',
            'default_sort' => 'nullable|string|in:recent,views,added,manual,connected,lit,title,author',
            // The shelf's overview book (ShelfOverview): a member's id, or
            // null / '' to clear it.
            'overview_book' => 'nullable|string|max:255',
        ]);

        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $shelf = DB::table('shelves')->where('id', $id)->where('creator', $user->name)->first();
        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        $updates = array_filter([
            'name' => $request->name,
            'description' => $request->description,
            'visibility' => $request->visibility,
            'default_sort' => $request->default_sort,
        ], fn($v) => $v !== null);

        // An explicitly-sent empty description CLEARS it (ConvertEmptyStrings
        // turns '' into null, which the filter above would drop as "absent").
        if ($request->has('description') && $request->description === null) {
            $updates['description'] = null;
        }

        // Regenerate slug when name changes
        if (isset($updates['name']) && $updates['name'] !== $shelf->name) {
            $updates['slug'] = $this->generateUniqueSlug($updates['name'], $user->name, $id);
        }

        // Overview: only a book that is ON this shelf can be nominated; an
        // explicit null/'' clears. (Any member — your own intro book, or one
        // of the readings.) Changing it reorders every cached render.
        $overviewChanged = false;
        if ($request->has('overview_book')) {
            $overview = $request->overview_book ?: null;
            if ($overview !== null) {
                $isMember = DB::connection('pgsql_admin')->table('shelf_items')
                    ->where('shelf_id', $id)->where('book', $overview)->exists();
                if (!$isMember) {
                    return response()->json(['error' => 'Only a book on this shelf can be its overview.'], 422);
                }
            }
            $overviewChanged = $overview !== ($shelf->overview_book ?? null);
            if ($overviewChanged) {
                $updates['overview_book'] = $overview;
            }
        }

        $sortChanged = isset($updates['default_sort']) && $updates['default_sort'] !== $shelf->default_sort;

        if (!empty($updates)) {
            $updates['updated_at'] = now();
            DB::connection('pgsql_admin')->table('shelves')->where('id', $id)->update($updates);
        }

        if ($sortChanged || $overviewChanged) {
            (new ShelfCacheInvalidator())->flush($id);
        }
        if ($overviewChanged && ($archiveId = \App\Models\ArchiveSource::where('shelf_id', $id)->value('id'))) {
            // The archive page's connection map leaves the overview out.
            Cache::forget(\App\Http\Controllers\ArchivePageController::mapCacheKey($archiveId));
        }

        return response()->json(['success' => true]);
    }

    /**
     * Delete a shelf (owner-only; flushes its cached synthetic book). @return array{success: true}|array{error: string}
     */
    public function destroy(Request $request, string $id)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $shelf = DB::table('shelves')->where('id', $id)->where('creator', $user->name)->first();
        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        // The Likes shelf is derived from book_likes, so deleting it is
        // incoherent rather than destructive: the likes survive, and the next
        // like rebuilds the shelf empty. Refuse instead of half-doing it.
        if (LikesShelf::isLikesShelf($shelf)) {
            return response()->json([
                'error' => 'The Likes shelf can\'t be deleted — it follows what you\'ve liked. Unlike books to empty it, or make it private.',
            ], 422);
        }
        if (($shelf->kind ?? null) === LicenceReviewShelf::KIND) {
            return response()->json([
                'error' => 'This shelf follows your published books that might not be OK to publish — it empties itself as you make them private.',
            ], 422);
        }

        // Flush cached synthetic books before deleting
        (new ShelfCacheInvalidator())->flush($id);

        DB::connection('pgsql_admin')->table('shelves')->where('id', $id)->delete();

        // archive_sources has no FK to shelves — an archive page for a deleted
        // shelf would be an empty hero squatting a global /a/ slug.
        \App\Models\ArchiveSource::where('shelf_id', $id)->delete();
        app(\App\Services\Archives\ArchiveAboutBook::class)->delete($id);
        DB::connection('pgsql_admin')->table('shelf_likes')->where('shelf_id', $id)->delete();

        return response()->json(['success' => true]);
    }

    /**
     * The owner's shelf, gated for an archive page: must exist, be theirs, be public.
     *
     * @return object|\Illuminate\Http\JsonResponse  the shelf row, or the refusal
     */
    private function archivableShelf(string $id)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }
        $shelf = DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $id)
            ->where('creator', $user->name)
            ->first(['id', 'name', 'slug', 'creator', 'visibility', 'kind']);
        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }
        // The licence-review shelf is a private worklist of books that may
        // NOT be OK to publish — giving it a global public page is the inverse
        // of its purpose.
        if (($shelf->kind ?? null) === LicenceReviewShelf::KIND) {
            return response()->json(['error' => 'This shelf lists books that might not be OK to publish, so it can\'t become an archive.'], 422);
        }
        if ($shelf->visibility !== 'public') {
            return response()->json(['error' => 'Make the shelf public to give it an archive page.'], 422);
        }

        return $shelf;
    }

    /**
     * PUT /api/shelves/{id}/archive/page-settings — the owner customizes their
     * archive page exactly like their user page (userPageEditor, same
     * UserPageSettingsValidator vocabulary), minus visitor shelf pills (an
     * archive IS one shelf). Stored on the About book's library row.
     */
    public function updateArchivePageSettings(
        Request $request,
        string $id,
        \App\Services\Archives\ShelfArchiveMinter $minter,
        \App\Services\Archives\ArchiveAboutBook $aboutBook,
        \App\Services\UserPageSettingsValidator $validator,
    ) {
        $shelf = $this->archivableShelf($id);
        if ($shelf instanceof \Illuminate\Http\JsonResponse) {
            return $shelf;
        }
        $archive = $minter->existing($shelf->id);
        if (!$archive || $archive->display_name !== null) {
            return response()->json(['error' => 'This shelf has no archive page of its own.'], 404);
        }

        $full = DB::connection('pgsql_admin')->table('shelves')->where('id', $shelf->id)
            ->first(['id', 'name', 'description', 'creator']);
        $book = $aboutBook->ensure($full);

        $input = $request->except(['pill_shelves', 'about_html', 'overview_as_about']);
        $result = $validator->validate($input, $book, $shelf->creator);
        // Archive-only: show the shelf's pinned OVERVIEW book as this page's
        // about text, in place of the page's own (editable) about. Default
        // OFF — only `true` is stored; false/null clear the key.
        if ($request->has('overview_as_about')) {
            $raw = $request->input('overview_as_about');
            if ($raw === true) {
                $result['settings']['overview_as_about'] = true;
            } elseif ($raw === false || $raw === null) {
                $result['settings']['overview_as_about'] = null;
            } else {
                $result['ok'] = false;
                $result['errors']['overview_as_about'] = 'overview_as_about must be a boolean.';
            }
        }
        if (!$result['ok']) {
            return response()->json(['error' => 'Validation failed', 'errors' => $result['errors']], 422);
        }
        unset($result['settings']['pill_shelves'], $result['settings']['about_html']);

        $merged = $aboutBook->saveSettings($shelf->id, $result['settings']);
        Cache::forget(\App\Http\Controllers\ArchivePageController::mapCacheKey($archive->id));

        return response()->json(['success' => true, 'page_settings' => $merged ?: (object) []]);
    }

    /**
     * GET /api/shelves/{id}/archive[?slug=] — does this shelf have an archive
     * page yet? If not: the suggested slug, plus whether ?slug= is free (the
     * live check behind the shelf header's one-time URL picker).
     */
    public function archiveStatus(Request $request, string $id, \App\Services\Archives\ShelfArchiveMinter $minter)
    {
        $shelf = $this->archivableShelf($id);
        if ($shelf instanceof \Illuminate\Http\JsonResponse) {
            return $shelf;
        }

        if ($archive = $minter->existing($shelf->id)) {
            return response()->json(['exists' => true, 'slug' => $archive->slug, 'url' => '/a/' . $archive->slug]);
        }

        $payload = ['exists' => false, 'suggestion' => $minter->suggest($shelf)];
        $asked = $request->query('slug');
        if (is_string($asked) && $asked !== '') {
            $payload['slug'] = $asked;
            $payload['valid'] = \App\Services\Archives\ShelfArchiveMinter::isValidSlug($asked);
            $payload['available'] = $minter->isAvailable($asked);
        }

        return response()->json($payload);
    }

    /**
     * POST /api/shelves/{id}/archive {slug} — mint the shelf's archive page.
     * SET ONCE: a shelf that already has one gets it back unchanged, whatever
     * slug was asked for (see ShelfArchiveMinter).
     */
    public function createArchive(Request $request, string $id, \App\Services\Archives\ShelfArchiveMinter $minter)
    {
        $shelf = $this->archivableShelf($id);
        if ($shelf instanceof \Illuminate\Http\JsonResponse) {
            return $shelf;
        }

        $slug = (string) $request->input('slug', '');
        if (!\App\Services\Archives\ShelfArchiveMinter::isValidSlug($slug)) {
            if ($archive = $minter->existing($shelf->id)) {
                return response()->json(['slug' => $archive->slug, 'url' => '/a/' . $archive->slug, 'created' => false]);
            }

            return response()->json([
                'error' => 'Use lowercase letters, numbers and single hyphens (max ' . \App\Services\Archives\ShelfArchiveMinter::SLUG_MAX . ').',
                'suggestion' => $minter->suggest($shelf),
            ], 422);
        }

        $result = $minter->mint($shelf, $slug);
        if ($result === null) {
            return response()->json([
                'error' => "/a/{$slug} is taken.",
                'suggestion' => $minter->suggest($shelf),
            ], 422);
        }
        return response()->json([
            'slug'    => $result['archive']->slug,
            'url'     => '/a/' . $result['archive']->slug,
            'created' => $result['created'],
        ]);
    }

    /**
     * Add a book to a shelf — upserts a `shelf_items` row (owner-only). Body: array{book: string}.
     * @return array{success: true}|array{error: string}
     */
    public function addItem(Request $request, string $id)
    {
        $request->validate([
            'book' => 'required|string',
        ]);

        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $shelf = DB::table('shelves')->where('id', $id)->where('creator', $user->name)->first();
        // An admin maintains the system-owned collection shelves (journals,
        // maintainer archives) — invisible to their RLS context, so looked up
        // on the admin connection. Same rule as ImportBatchController::store.
        if (!$shelf && $user->isAdmin()) {
            $shelf = DB::connection('pgsql_admin')->table('shelves')->where('id', $id)
                ->where('creator', \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR)->first();
        }
        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        // Membership of the Likes shelf comes from liking, full stop — letting
        // a book in here would be the drift this design exists to prevent
        // (LikesShelf is the single writer).
        if (LikesShelf::isLikesShelf($shelf)) {
            return response()->json([
                'error' => 'Books join the Likes shelf by being liked, not by being added.',
            ], 422);
        }
        if (ShelfKinds::isSystem($shelf)) {
            return response()->json(['error' => 'This shelf is kept up to date automatically — books can\'t be added by hand.'], 422);
        }

        // Upsert (ignore if already exists)
        DB::connection('pgsql_admin')->table('shelf_items')->updateOrInsert(
            ['shelf_id' => $id, 'book' => $request->book],
            ['added_at' => now()]
        );

        (new ShelfCacheInvalidator())->flush($id);

        DB::connection('pgsql_admin')->table('shelves')->where('id', $id)->update(['updated_at' => now()]);

        return response()->json(['success' => true]);
    }

    /**
     * Remove a book from a shelf — deletes the `shelf_items` row (owner-only).
     * @return array{success: true}|array{error: string}
     */
    public function removeItem(Request $request, string $id, string $book)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $shelf = DB::table('shelves')->where('id', $id)->where('creator', $user->name)->first();
        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        if (($shelf->kind ?? null) === LicenceReviewShelf::KIND) {
            return response()->json([
                'error' => 'Make the book private (or give it an open licence) to take it off this shelf.',
            ], 422);
        }

        // Removing from the Likes shelf IS unliking — otherwise the row comes
        // straight back on the next sync and the gesture looks broken. Drop the
        // like and let LikesShelf mirror it, so book_likes stays the truth.
        if (LikesShelf::isLikesShelf($shelf)) {
            DB::table('book_likes')
                ->where('book', $book)
                ->where('creator', $user->name)
                ->delete();

            LikesShelf::sync($user->name, $book, false);

            DB::afterCommit(function () use ($book) {
                try {
                    (new ReadStatsCounter())->recomputeLikes([$book]);
                } catch (\Throwable $e) {
                    Log::warning('total_likes recompute failed (non-fatal)', [
                        'book' => $book,
                        'error' => $e->getMessage(),
                    ]);
                }
            });

            return response()->json(['success' => true, 'unliked' => true]);
        }

        DB::connection('pgsql_admin')->table('shelf_items')
            ->where('shelf_id', $id)
            ->where('book', $book)
            ->delete();
        \App\Services\Shelves\ShelfOverview::forget($book, $id);

        (new ShelfCacheInvalidator())->flush($id);

        return response()->json(['success' => true]);
    }

    /**
     * Pin a book within a shelf context.
     */
    public function pin(Request $request, string $shelfKey)
    {
        $request->validate([
            'book' => 'required|string',
            'position' => 'nullable|numeric',
        ]);

        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        DB::connection('pgsql_admin')->table('shelf_pins')->updateOrInsert(
            ['shelf_key' => $shelfKey, 'book' => $request->book],
            [
                'position' => $request->position ?? 0,
                'creator' => $user->name,
                'creator_token' => null,
            ]
        );

        // Invalidate cache for shelf if it's a shelf:uuid key
        if (str_starts_with($shelfKey, 'shelf:')) {
            $shelfId = substr($shelfKey, 6);
            (new ShelfCacheInvalidator())->flush($shelfId);
        }

        return response()->json(['success' => true]);
    }

    /**
     * Unpin a book from a shelf context.
     */
    public function unpin(Request $request, string $shelfKey, string $book)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        DB::connection('pgsql_admin')->table('shelf_pins')
            ->where('shelf_key', $shelfKey)
            ->where('book', $book)
            ->where('creator', $user->name)
            ->delete();

        if (str_starts_with($shelfKey, 'shelf:')) {
            $shelfId = substr($shelfKey, 6);
            (new ShelfCacheInvalidator())->flush($shelfId);
        }

        return response()->json(['success' => true]);
    }

    /**
     * Render a shelf as a synthetic book (generate nodes from shelf items).
     * Returns the synthetic book ID for chunk loading.
     */
    /**
     * F12: single-flight the synthetic-book node DELETE+INSERT.
     *
     * render()/publicRender() rebuild a SHARED row set ("shelf_{id}_{sort}[_pub]")
     * on a cache miss. Without a lock, concurrent first-viewers (esp. on the public,
     * unauthenticated path) all delete+insert at once and collide on the
     * nodes_book_startline_unique / nodes_book_node_id_unique indexes → 500s + a
     * half-built render. Here only ONE caller writes; the rest wait, see the rows
     * now exist (double-check), and skip. The lock TTL is a crash backstop.
     */
    /**
     * Numeric sort key for a biblio volume/issue string: the first integer in
     * it ("12" → 12, "S1" → 1, "3-4" → 3), 0 when absent so missing values
     * sink in a descending sort.
     */
    private static function biblioNumber(?string $value): int
    {
        if ($value !== null && preg_match('/\d+/', $value, $m)) {
            return (int) $m[0];
        }
        return 0;
    }

    private function writeRenderNodes(string $syntheticBookId, array $chunks): void
    {
        $admin = DB::connection('pgsql_admin');
        $lock = Cache::lock("shelf-render:{$syntheticBookId}", 30);
        try {
            $lock->block(10);
        } catch (LockTimeoutException $e) {
            return; // another request is building these rows; ours would only collide
        }
        try {
            if ($admin->table('nodes')->where('book', $syntheticBookId)->exists()) {
                return; // built while we waited
            }
            $admin->table('nodes')->where('book', $syntheticBookId)->delete();
            foreach (array_chunk($chunks, 500) as $batch) {
                $admin->table('nodes')->insert($batch);
            }
        } finally {
            $lock->release();
        }
    }

    /**
     * Render a shelf to a SYNTHETIC book — materializes the shelf's `shelf_items` as a virtual book
     * (nodes) and returns its id, which the reader then loads via the normal content pipeline.
     * `publicRender` is the auth-optional twin for public shelves.
     *
     * @return \Illuminate\Http\JsonResponse array{bookId: string} | array{error: string}
     */
    public function render(Request $request, string $id)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $shelf = DB::table('shelves')->where('id', $id)->where('creator', $user->name)->first();
        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        $sort = $request->query('sort', $shelf->default_sort ?? 'recent');

        return $this->renderShelfFeed($shelf, $id, $sort, true);
    }

    /**
     * Public render of a shelf (no auth required).
     * Mirrors render() but only works for public shelves, no pins, and marks private books as locked.
     */
    public function publicRender(Request $request, string $id)
    {
        $shelf = DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $id)
            ->where('visibility', 'public')
            ->first();

        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        $sort = $request->query('sort', $shelf->default_sort ?? 'recent');

        return $this->renderShelfFeed($shelf, $id, $sort, false);
    }

    /**
     * The shared body of render()/publicRender(). Owner and public differ only
     * in: synthetic id suffix (`_pub`), the pin overlay (owner only), locked
     * cards for non-public members (public only), and the synthetic library
     * row's visibility/raw_json.
     */
    private function renderShelfFeed(object $shelf, string $id, string $sort, bool $isOwner)
    {
        $syntheticBookId = 'shelf_' . $id . '_' . $sort . ($isOwner ? '' : '_pub');

        // Check if already rendered (cache hit)
        $existing = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $syntheticBookId)
            ->exists();

        // A ranking sort's order changes behind the render, so its cache expires;
        // every other sort stays cached until the shelf is mutated.
        if ($existing && ! ConnectionRefresher::cachedRenderIsStale($syntheticBookId, $sort)) {
            return response()->json(['bookId' => $syntheticBookId]);
        }
        if ($existing) {
            DB::connection('pgsql_admin')->table('nodes')->where('book', $syntheticBookId)->delete();
        }

        // Fetch shelf items joined with library for citation data. Deleted books
        // are excluded — BookDeletionService removes shelf memberships on delete,
        // but rows stranded BEFORE that cleanup existed (e.g. retracted harvest
        // junk) must not render as "No content available" corpse cards.
        $items = DB::connection('pgsql_admin')->table('shelf_items')
            ->join('library', 'shelf_items.book', '=', 'library.book')
            ->where('shelf_items.shelf_id', $id)
            ->where('library.visibility', '!=', 'deleted')
            ->select([
                'library.book', 'library.title', 'library.author', 'library.year',
                'library.volume', 'library.issue',
                'library.publisher', 'library.journal', 'library.bibtex', 'library.created_at',
                'library.total_views', 'library.total_highlights',
                'library.hypercite_connections', 'library.reference_connections',
                'library.visibility as book_visibility',
                'shelf_items.added_at', 'shelf_items.manual_position',
            ])
            ->get();

        // Apply sort
        $items = match ($sort) {
            'title' => $items->sortBy(fn($i) => \App\Support\FeedSortKey::for($i->title)),
            'author' => $items->sortBy(fn($i) => \App\Support\FeedSortKey::for($i->author)),
            'views' => $items->sortByDesc('total_views'),
            // Docuverse connectedness, both directions — ConnectionCountQuery owns
            // the definition and the tie-breaking so all four sort sites agree.
            'connected' => ConnectionCountQuery::sortConnected($items),
            'lit' => ConnectionCountQuery::sortLit($items),
            'added' => $items->sortByDesc('added_at'),
            'manual' => $items->sortBy('manual_position'),
            // Publication order for journals: year → volume → issue, all desc.
            // Stable sorts applied in reverse so year is primary and issues
            // stay ordered within a volume. Volume/issue are strings ("12",
            // "S1", "3-4") — compare by their first integer, missing sinks.
            'published' => $items->sortByDesc('created_at')
                ->sortByDesc(fn($i) => self::biblioNumber($i->issue ?? null))
                ->sortByDesc(fn($i) => self::biblioNumber($i->volume ?? null))
                ->sortByDesc(fn($i) => (int) ($i->year ?: 0)),
            // Plain publication year, for non-journal archives.
            'year' => $items->sortByDesc('created_at')
                ->sortByDesc(fn($i) => (int) ($i->year ?: 0)),
            default => $items->sortByDesc('created_at'), // 'recent'
        };

        // Overlay pins on top (owner view only)
        if ($isOwner) {
            $pins = DB::connection('pgsql_admin')->table('shelf_pins')
                ->where('shelf_key', 'shelf:' . $id)
                ->where('creator', $shelf->creator)
                ->orderBy('position')
                ->pluck('book')
                ->toArray();

            if (!empty($pins)) {
                $pinnedItems = $items->whereIn('book', $pins)->sortBy(function ($item) use ($pins) {
                    return array_search($item->book, $pins);
                });
                $unpinnedItems = $items->whereNotIn('book', $pins);
                $items = $pinnedItems->merge($unpinnedItems);
            }
        }

        // The shelf's OVERVIEW book (ShelfOverview) leads every sort, for
        // EVERY viewer, and its card wears a visible pin. Visitors only get it
        // pinned when it's a book they can open — a locked card on top of the
        // shelf would be a dead end where the intro should be.
        $overviewBook = \App\Services\Shelves\ShelfOverview::memberBook($id);
        if ($overviewBook !== null) {
            $lead = $items->firstWhere('book', $overviewBook);
            if ($lead && ($isOwner || ($lead->book_visibility ?? 'public') === 'public')) {
                $items = collect([$lead])->merge($items->reject(fn ($i) => $i->book === $overviewBook));
            } else {
                $overviewBook = null;
            }
        }

        $items = $items->values();

        // Generate nodes using LibraryCardGenerator
        $generator = new LibraryCardGenerator();
        $chunks = [];
        $positionId = 100;

        foreach ($items as $i => $record) {
            $locked = !$isOwner && ($record->book_visibility ?? 'public') !== 'public';
            $chunk = $generator->generateLibraryCardChunk($record, $syntheticBookId, $positionId, $isOwner, false, $i, 'public', $locked);
            if ($overviewBook !== null && $record->book === $overviewBook) {
                $chunk = $generator->markAsOverview($chunk);
            }
            $chunks[] = $chunk;
            $positionId++;
        }

        if ($items->isEmpty()) {
            $chunks[] = $generator->generateLibraryCardChunk(null, $syntheticBookId, 1, $isOwner, true, 0);
        }

        $rawJson = ['type' => 'shelf', 'shelf_id' => $id, 'sort' => $sort];
        if (!$isOwner) {
            $rawJson['public'] = true;
        }

        // Ensure library record exists for the synthetic book
        DB::connection('pgsql_admin')->table('library')->updateOrInsert(
            ['book' => $syntheticBookId],
            [
                'title' => $shelf->name,
                'visibility' => $isOwner ? $shelf->visibility : 'public',
                'listed' => false,
                'creator' => $shelf->creator,
                'creator_token' => null,
                'raw_json' => json_encode($rawJson),
                'timestamp' => round(microtime(true) * 1000),
                'updated_at' => now(),
                'created_at' => now(),
            ]
        );

        // Insert nodes — single-flight so concurrent first-viewers of the same
        // shelf don't race the shared synthetic rows (F12; see writeRenderNodes).
        $this->writeRenderNodes($syntheticBookId, $chunks);

        return response()->json(['bookId' => $syntheticBookId]);
    }

    /**
     * The shelf's public member books — the visibility scope for every
     * publicSearch mode. Resolved via pgsql_admin: shelf_items' RLS select
     * policy is owner-only, so a guest-context join yields nothing.
     */
    private function shelfPublicBooks(string $id): array
    {
        return DB::connection('pgsql_admin')->table('shelf_items')
            ->join('library', 'shelf_items.book', '=', 'library.book')
            ->where('shelf_items.shelf_id', $id)
            ->where('library.visibility', 'public')
            ->pluck('library.book')
            ->toArray();
    }

    /**
     * Public search within a public shelf's books (no auth required) —
     * mode=library (titles), mode=semantic (embeddings), default full-text.
     * Only ever searches public books in the shelf.
     */
    public function publicSearch(Request $request, string $id)
    {
        $shelf = DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $id)
            ->where('visibility', 'public')
            ->first();

        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
        }

        $query = $request->input('q', '');
        $limit = min((int) $request->input('limit', 50), 50);

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        $searchService = app(SearchService::class);

        // mode=library: titles & authors within the shelf's public books —
        // the journal page's default search mode (homepage parity: its toggle
        // switches titles↔full-text exactly like home's, just shelf-scoped).
        if ($request->input('mode') === 'library') {
            $shelfBooks = $this->shelfPublicBooks($id);

            $results = $searchService->searchLibraryByKeyword($query, min($limit, 20), 'books', null, null, $shelfBooks);

            return response()->json([
                'success' => true,
                'mode'    => 'library',
                'results' => array_map(fn ($r) => [
                    'book'     => $r->book,
                    'title'    => $r->title,
                    'author'   => $r->author,
                    'year'     => $r->year,
                    'headline' => e(trim(($r->title ?? '') . ($r->author ? ' — ' . $r->author : ''))),
                ], $results),
                'query'   => $query,
            ]);
        }

        // mode=semantic: same engine as the homepage semantic endpoint
        // (shared embed cache + SearchService::runSemanticNodeSearch), scoped
        // to the shelf's public members instead of the global visible set.
        if ($request->input('mode') === 'semantic') {
            if (mb_strlen($query) < 3) {
                return response()->json([
                    'success' => true,
                    'results' => [],
                    'query' => $query,
                    'mode' => 'semantic',
                ]);
            }

            $norm = mb_strtolower($query);
            $queryEmbedding = app(EmbeddingService::class)->embedSearchQuery($norm);
            if ($queryEmbedding === null) {
                return response()->json([
                    'success' => false,
                    'message' => 'Semantic search is temporarily unavailable',
                ], 503);
            }

            // Public shelf → identical results for every viewer, cache per shelf.
            $payload = Cache::remember(
                'search:semantic:shelf:' . $id . ':' . md5($norm) . ':' . $limit,
                60,
                function () use ($searchService, $queryEmbedding, $limit, $id) {
                    $results = $searchService->runSemanticNodeSearch(
                        $queryEmbedding,
                        $limit,
                        $this->shelfPublicBooks($id),
                    );
                    return ['results' => $results, 'count' => $results->count()];
                }
            );

            return response()->json([
                'success' => true,
                'results' => $payload['results'],
                'query' => $query,
                'mode' => 'semantic',
                'count' => $payload['count'],
            ]);
        }

        $tsQuery = $searchService->buildTsQuery($query);

        if (empty($tsQuery)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        // Only search public books in the shelf
        $books = $this->shelfPublicBooks($id);

        if (empty($books)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        // Two-stage search: exact first, fallback to stemmed
        $results = $this->executeShelfNodeSearch($tsQuery, 'simple', $books, $limit);
        $searchType = 'exact';

        if ($results->isEmpty()) {
            $results = $this->executeShelfNodeSearch($tsQuery, 'english', $books, $limit);
            $searchType = 'stemmed';
        }

        $groupedResults = $results->groupBy('book')->map(function ($bookResults) {
            $first = $bookResults->first();
            return [
                'book' => $first->book,
                'title' => $first->title,
                'author' => $first->author,
                'matches' => $bookResults->map(fn($r) => [
                    'node_id' => $r->node_id,
                    'startLine' => $r->startLine,
                    'headline' => $r->headline,
                ])->values(),
            ];
        })->values();

        return response()->json([
            'success' => true,
            'results' => $groupedResults,
            'query' => $query,
            'search_type' => $searchType,
            'count' => $results->count(),
        ]);
    }

    /**
     * Full-text search within a shelf's books.
     * GET /api/shelves/{id}/search?q=query
     *
     * {id} can be a UUID (custom shelf) or "public"/"private" (system shelf).
     */
    public function search(Request $request, string $id)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $query = $request->input('q', '');
        $limit = min((int) $request->input('limit', 50), 50);

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        $searchService = app(SearchService::class);
        $tsQuery = $searchService->buildTsQuery($query);

        if (empty($tsQuery)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        // Resolve the book list for this shelf
        if ($id === 'all') {
            $sanitized = str_replace(' ', '', $user->name);
            $books = DB::table('library')
                ->where('creator', $user->name)
                ->whereIn('visibility', ['public', 'private'])
                ->whereRaw("book NOT LIKE '%/%'")
                ->where('book', '!=', $sanitized)
                ->where('book', '!=', $sanitized . 'Private')
                ->where('book', '!=', $sanitized . 'All')
                ->where('book', '!=', $sanitized . 'Account')
                ->where('book', '!=', $sanitized . 'About')
                ->where('book', 'NOT LIKE', 'shelf_%')
                ->pluck('book')
                ->toArray();
        } elseif ($id === 'public' || $id === 'private') {
            $books = DB::table('library')
                ->where('creator', $user->name)
                ->where('visibility', $id)
                ->where('visibility', '!=', 'deleted')
                ->whereRaw("book NOT LIKE '%/%'")
                ->pluck('book')
                ->toArray();
        } else {
            $shelf = DB::table('shelves')->where('id', $id)->where('creator', $user->name)->first();
            if (!$shelf) {
                return response()->json(['error' => 'Shelf not found'], 404);
            }
            $books = DB::table('shelf_items')
                ->where('shelf_id', $id)
                ->pluck('book')
                ->toArray();
        }

        if (empty($books)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        // Two-stage search: exact (simple) first, fallback to stemmed (english)
        $results = $this->executeShelfNodeSearch($tsQuery, 'simple', $books, $limit);
        $searchType = 'exact';

        if ($results->isEmpty()) {
            $results = $this->executeShelfNodeSearch($tsQuery, 'english', $books, $limit);
            $searchType = 'stemmed';
        }

        $groupedResults = $results->groupBy('book')->map(function ($bookResults) {
            $first = $bookResults->first();
            return [
                'book' => $first->book,
                'title' => $first->title,
                'author' => $first->author,
                'matches' => $bookResults->map(fn($r) => [
                    'node_id' => $r->node_id,
                    'startLine' => $r->startLine,
                    'headline' => $r->headline,
                ])->values(),
            ];
        })->values();

        return response()->json([
            'success' => true,
            'results' => $groupedResults,
            'query' => $query,
            'search_type' => $searchType,
            'count' => $results->count(),
        ]);
    }

    /**
     * The searchable corpus of a user's library page: their REAL books only.
     * Synthetic rows (the four user-home books, sorted variants, shelf
     * renders, sub-books) share creator = username, so without these
     * exclusions a search would also hit the library-card lists themselves.
     */
    private function userLibraryBooks(string $username, bool $includePrivate): array
    {
        // One definition of "a user's real books" — shared with the archive
        // export corpus (ArchiveCorpusResolver), so search and export can't
        // drift on the synthetic-book exclusions.
        return app(\App\Services\Export\ArchiveCorpusResolver::class)
            ->userLibraryQuery($username, $includePrivate)
            ->pluck('book')
            ->toArray();
    }

    /**
     * A shelf's member books as this viewer may see them — the corpus when the
     * /u/{username} search box is narrowed to an open shelf tab.
     *
     * Public members always; the page's OWNER additionally sees their own
     * private books inside their shelf, which is the same rule the un-narrowed
     * owner search follows (userLibraryBooks with $includePrivate). Members
     * created by OTHER users stay in scope while public — the shelf feed lists
     * them, so a search of that shelf must reach them too.
     *
     * Read via pgsql_admin for the same reason shelfPublicBooks is: shelf_items'
     * RLS select policy is owner-only, so a visitor's session sees every shelf
     * as empty.
     */
    private function shelfBooksForViewer(string $shelfId, bool $includePrivate, string $ownerName): array
    {
        return DB::connection('pgsql_admin')->table('shelf_items')
            ->join('library', 'shelf_items.book', '=', 'library.book')
            ->where('shelf_items.shelf_id', $shelfId)
            ->where(function ($q) use ($includePrivate, $ownerName) {
                $q->where('library.visibility', 'public');
                if ($includePrivate) {
                    $q->orWhere(function ($inner) use ($ownerName) {
                        $inner->where('library.visibility', 'private')
                              ->where('library.creator', $ownerName);
                    });
                }
            })
            ->pluck('library.book')
            ->toArray();
    }

    /**
     * Search within a user's library — the /u/{username} hero search box.
     * GET /api/public/library/{username}/search?q=query[&mode=library|semantic][&shelf={uuid}]
     *
     * No auth required; a signed-in OWNER (resolved via the sanctum guard —
     * this route sits outside auth middleware) searches their private books
     * too, everyone else sees public only. Modes mirror publicSearch above:
     * mode=library (titles/authors), mode=semantic (embeddings), default
     * full-text over node content.
     *
     * `shelf` narrows the corpus to one of THIS user's shelves — the page's
     * open shelf tab, so the box searches what the feed is showing. Unlike
     * publicSearch (a standalone public endpoint), a PRIVATE shelf is allowed
     * for its owner: the tab only exists in an owner session, and the owner
     * search already reaches their private books. A shelf belonging to anyone
     * else 404s, so a user page can't be used to proxy-search someone else's
     * shelf.
     */
    public function publicSystemSearch(Request $request, string $username)
    {
        $user = \App\Models\User::findByNamePublic($username);
        if (!$user) {
            return response()->json(['error' => 'User not found'], 404);
        }

        $viewer = Auth::guard('sanctum')->user();
        $isOwner = $viewer && $viewer->name === $user->name;

        // Optional shelf narrowing. The uuid shape is checked BEFORE the query:
        // `shelves.id` is a uuid column, so a junk value would raise a PG cast
        // error instead of a clean 404.
        $shelfId = trim((string) $request->input('shelf', ''));
        $shelf = null;
        if ($shelfId !== '') {
            $shelf = Str::isUuid($shelfId)
                ? DB::connection('pgsql_admin')->table('shelves')
                    ->where('id', $shelfId)
                    ->where('creator', $user->name)
                    ->when(!$isOwner, fn ($q) => $q->where('visibility', 'public'))
                    ->first(['id', 'name'])
                : null;
            if (!$shelf) {
                return response()->json(['error' => 'Shelf not found'], 404);
            }
        }

        // The corpus for every mode below: the shelf's members when narrowed,
        // the user's whole library otherwise.
        $corpus = fn (): array => $shelf
            ? $this->shelfBooksForViewer((string) $shelf->id, $isOwner, $user->name)
            : $this->userLibraryBooks($user->name, $isOwner);

        $query = $request->input('q', '');
        $limit = min((int) $request->input('limit', 50), 50);

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        $searchService = app(SearchService::class);

        // mode=library: titles & authors within the user's books (the hero
        // box's default mode — journal-page parity, user-scoped).
        if ($request->input('mode') === 'library') {
            $books = $corpus();

            if (empty($books)) {
                $results = [];
            } elseif ($isOwner) {
                // Owner path: their PRIVATE titles must match too, which the
                // shared searchLibraryByKeyword deliberately never returns
                // (its "no private book ever" contract guards the AI-retrieval
                // seams). Query directly under the owner's own RLS session —
                // the session is the authorization.
                $tsq = $searchService->buildTsQuery($query);
                $results = empty($tsq) ? [] : DB::table('library')
                    ->selectRaw("
                        library.book,
                        library.title,
                        library.author,
                        library.year,
                        ts_rank('{0.05, 0.1, 0.3, 1.0}', library.search_vector, to_tsquery('simple', ?)) as relevance
                    ", [$tsq])
                    ->whereRaw("library.search_vector @@ to_tsquery('simple', ?)", [$tsq])
                    ->whereIn('library.book', $books)
                    ->orderByDesc('relevance')
                    ->limit(min($limit, 20))
                    ->get()
                    ->all();
            } else {
                $results = $searchService->searchLibraryByKeyword($query, min($limit, 20), 'books', null, null, $books);
            }

            return response()->json([
                'success' => true,
                'mode'    => 'library',
                'results' => array_map(fn ($r) => [
                    'book'     => $r->book,
                    'title'    => $r->title,
                    'author'   => $r->author,
                    'year'     => $r->year,
                    'headline' => e(trim(($r->title ?? '') . ($r->author ? ' — ' . $r->author : ''))),
                ], $results),
                'query'   => $query,
            ]);
        }

        // mode=semantic: shared embed cache + runSemanticNodeSearch scoped to
        // the user's books. Only the anonymous/visitor payload is cached —
        // the owner's corpus includes private books, so it is per-viewer.
        if ($request->input('mode') === 'semantic') {
            if (mb_strlen($query) < 3) {
                return response()->json([
                    'success' => true,
                    'results' => [],
                    'query' => $query,
                    'mode' => 'semantic',
                ]);
            }

            $norm = mb_strtolower($query);
            $queryEmbedding = app(EmbeddingService::class)->embedSearchQuery($norm);
            if ($queryEmbedding === null) {
                return response()->json([
                    'success' => false,
                    'message' => 'Semantic search is temporarily unavailable',
                ], 503);
            }

            $run = function () use ($searchService, $queryEmbedding, $limit, $corpus) {
                $results = $searchService->runSemanticNodeSearch(
                    $queryEmbedding,
                    $limit,
                    $corpus(),
                );
                return ['results' => $results, 'count' => $results->count()];
            };

            // Cache key carries the shelf: the same query against the library
            // and against one of its shelves are different result sets.
            $payload = $isOwner
                ? $run()
                : Cache::remember(
                    'search:semantic:user:' . str_replace(' ', '', $user->name)
                        . ($shelf ? ':shelf:' . $shelf->id : '')
                        . ':' . md5($norm) . ':' . $limit,
                    60,
                    $run,
                );

            return response()->json([
                'success' => true,
                'results' => $payload['results'],
                'query' => $query,
                'mode' => 'semantic',
                'count' => $payload['count'],
            ]);
        }

        $tsQuery = $searchService->buildTsQuery($query);

        if (empty($tsQuery)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        $books = $corpus();

        if (empty($books)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        // Two-stage search: exact first, fallback to stemmed
        $results = $this->executeShelfNodeSearch($tsQuery, 'simple', $books, $limit);
        $searchType = 'exact';

        if ($results->isEmpty()) {
            $results = $this->executeShelfNodeSearch($tsQuery, 'english', $books, $limit);
            $searchType = 'stemmed';
        }

        $groupedResults = $results->groupBy('book')->map(function ($bookResults) {
            $first = $bookResults->first();
            return [
                'book' => $first->book,
                'title' => $first->title,
                'author' => $first->author,
                'matches' => $bookResults->map(fn($r) => [
                    'node_id' => $r->node_id,
                    'startLine' => $r->startLine,
                    'headline' => $r->headline,
                ])->values(),
            ];
        })->values();

        return response()->json([
            'success' => true,
            'results' => $groupedResults,
            'query' => $query,
            'search_type' => $searchType,
            'count' => $results->count(),
        ]);
    }

    /**
     * Execute node search scoped to a specific set of books.
     * Config whitelist (🔒 SQL-injection guard) is enforced by
     * SearchService::nodeTsExpression, which also builds the exact
     * expression the GIN expression indexes are defined on.
     */
    protected function executeShelfNodeSearch(string $tsQuery, string $config, array $books, int $limit)
    {
        $tsExpr = SearchService::nodeTsExpression($config);

        $placeholders = implode(',', array_fill(0, count($books), '?'));

        $sql = "
            SELECT
                sub.book,
                sub.node_id,
                sub.\"startLine\",
                sub.title,
                sub.author,
                ts_headline('{$config}', sub.text_content,
                    to_tsquery('{$config}', ?),
                    'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
                ) as headline
            FROM (
                SELECT
                    nodes.book,
                    nodes.node_id,
                    nodes.\"startLine\",
                    library.title,
                    library.author,
                    COALESCE(nodes.\"plainText\", nodes.content, '') as text_content,
                    {$tsExpr} AS vec
                FROM nodes
                JOIN library ON nodes.book = library.book
                WHERE {$tsExpr} @@ to_tsquery('{$config}', ?)
                    AND nodes.book IN ({$placeholders})
                LIMIT ?
            ) sub
            ORDER BY ts_rank_cd(sub.vec, to_tsquery('{$config}', ?)) DESC
        ";

        $params = array_merge(
            [$tsQuery, $tsQuery],
            $books,
            [$limit, $tsQuery]
        );

        return collect(DB::select($sql, $params));
    }
}
