<?php

namespace App\Http\Controllers;

use App\Models\Shelf;
use App\Models\ShelfItem;
use App\Models\ShelfPin;
use App\Services\LibraryCardGenerator;
use App\Services\SearchService;
use App\Services\ShelfCacheInvalidator;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class ShelfController extends Controller
{
    /**
     * Generate a unique slug for a shelf, scoped to the creator.
     * Appends -2, -3 etc. if a collision exists.
     */
    private function generateUniqueSlug(string $name, string $creator, ?string $excludeId = null): string
    {
        $baseSlug = Str::slug($name);
        if ($baseSlug === '') {
            $baseSlug = 'shelf';
        }

        $slug = $baseSlug;
        $counter = 2;

        while (true) {
            $query = DB::table('shelves')
                ->where('creator', $creator)
                ->where('slug', $slug);

            if ($excludeId) {
                $query->where('id', '!=', $excludeId);
            }

            if (!$query->exists()) {
                break;
            }

            $slug = $baseSlug . '-' . $counter;
            $counter++;
        }

        return $slug;
    }

    /**
     * List current user's shelves.
     */
    public function index(Request $request)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['error' => 'Unauthenticated'], 401);
        }

        $shelves = DB::table('shelves')
            ->where('creator', $user->name)
            ->orderByDesc('updated_at')
            ->get(['id', 'name', 'slug', 'description', 'visibility', 'default_sort', 'created_at', 'updated_at']);

        return response()->json(['shelves' => $shelves]);
    }

    /**
     * Create a new shelf.
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
     * Update a shelf (rename, visibility, default_sort).
     */
    public function update(Request $request, string $id)
    {
        $request->validate([
            'name' => 'nullable|string|max:255',
            'description' => 'nullable|string',
            'visibility' => 'nullable|string|in:private,public',
            'default_sort' => 'nullable|string|in:recent,views,added,manual,connected,lit,title,author',
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

        // Regenerate slug when name changes
        if (isset($updates['name']) && $updates['name'] !== $shelf->name) {
            $updates['slug'] = $this->generateUniqueSlug($updates['name'], $user->name, $id);
        }

        $sortChanged = isset($updates['default_sort']) && $updates['default_sort'] !== $shelf->default_sort;

        if (!empty($updates)) {
            $updates['updated_at'] = now();
            DB::connection('pgsql_admin')->table('shelves')->where('id', $id)->update($updates);
        }

        if ($sortChanged) {
            (new ShelfCacheInvalidator())->flush($id);
        }

        return response()->json(['success' => true]);
    }

    /**
     * Delete a shelf.
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

        // Flush cached synthetic books before deleting
        (new ShelfCacheInvalidator())->flush($id);

        DB::connection('pgsql_admin')->table('shelves')->where('id', $id)->delete();

        return response()->json(['success' => true]);
    }

    /**
     * Add a book to a shelf.
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
        if (!$shelf) {
            return response()->json(['error' => 'Shelf not found'], 404);
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
     * Remove a book from a shelf.
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

        DB::connection('pgsql_admin')->table('shelf_items')
            ->where('shelf_id', $id)
            ->where('book', $book)
            ->delete();

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
        $syntheticBookId = 'shelf_' . $id . '_' . $sort;

        // Check if already rendered (cache hit)
        $existing = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $syntheticBookId)
            ->exists();

        if ($existing) {
            return response()->json(['bookId' => $syntheticBookId]);
        }

        // Fetch shelf items joined with library for citation data
        $items = DB::connection('pgsql_admin')->table('shelf_items')
            ->join('library', 'shelf_items.book', '=', 'library.book')
            ->where('shelf_items.shelf_id', $id)
            ->select([
                'library.book', 'library.title', 'library.author', 'library.year',
                'library.publisher', 'library.journal', 'library.bibtex', 'library.created_at',
                'library.total_views', 'library.total_citations', 'library.total_highlights',
                'shelf_items.added_at', 'shelf_items.manual_position',
            ])
            ->get();

        // Apply sort
        $items = match ($sort) {
            'title' => $items->sortBy(fn($i) => mb_strtolower($i->title ?? '')),
            'author' => $items->sortBy(fn($i) => mb_strtolower($i->author ?? '')),
            'views' => $items->sortByDesc('total_views'),
            'connected' => $items->sortByDesc('total_citations'),
            'lit' => $items->sortByDesc(fn($i) => ($i->total_citations ?? 0) + ($i->total_highlights ?? 0)),
            'added' => $items->sortByDesc('added_at'),
            'manual' => $items->sortBy('manual_position'),
            default => $items->sortByDesc('created_at'), // 'recent'
        };

        // Overlay pins on top
        $pins = DB::connection('pgsql_admin')->table('shelf_pins')
            ->where('shelf_key', 'shelf:' . $id)
            ->where('creator', $user->name)
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

        $items = $items->values();

        // Generate nodes using LibraryCardGenerator
        $generator = new LibraryCardGenerator();
        $chunks = [];
        $positionId = 100;

        foreach ($items as $i => $record) {
            $chunks[] = $generator->generateLibraryCardChunk($record, $syntheticBookId, $positionId, true, false, $i);
            $positionId++;
        }

        if ($items->isEmpty()) {
            $chunks[] = $generator->generateLibraryCardChunk(null, $syntheticBookId, 1, true, true, 0);
        }

        // Ensure library record exists for the synthetic book
        DB::connection('pgsql_admin')->table('library')->updateOrInsert(
            ['book' => $syntheticBookId],
            [
                'title' => $shelf->name,
                'visibility' => $shelf->visibility,
                'listed' => false,
                'creator' => $user->name,
                'creator_token' => null,
                'raw_json' => json_encode(['type' => 'shelf', 'shelf_id' => $id, 'sort' => $sort]),
                'timestamp' => round(microtime(true) * 1000),
                'updated_at' => now(),
                'created_at' => now(),
            ]
        );

        // Insert nodes
        DB::connection('pgsql_admin')->table('nodes')->where('book', $syntheticBookId)->delete();
        foreach (array_chunk($chunks, 500) as $batch) {
            DB::connection('pgsql_admin')->table('nodes')->insert($batch);
        }

        return response()->json(['bookId' => $syntheticBookId]);
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
        $syntheticBookId = 'shelf_' . $id . '_' . $sort . '_pub';

        // Check if already rendered (cache hit)
        $existing = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $syntheticBookId)
            ->exists();

        if ($existing) {
            return response()->json(['bookId' => $syntheticBookId]);
        }

        // Fetch shelf items joined with library for citation data + visibility
        $items = DB::connection('pgsql_admin')->table('shelf_items')
            ->join('library', 'shelf_items.book', '=', 'library.book')
            ->where('shelf_items.shelf_id', $id)
            ->select([
                'library.book', 'library.title', 'library.author', 'library.year',
                'library.publisher', 'library.journal', 'library.bibtex', 'library.created_at',
                'library.total_views', 'library.total_citations', 'library.total_highlights',
                'library.visibility as book_visibility',
                'shelf_items.added_at', 'shelf_items.manual_position',
            ])
            ->get();

        // Apply sort
        $items = match ($sort) {
            'title' => $items->sortBy(fn($i) => mb_strtolower($i->title ?? '')),
            'author' => $items->sortBy(fn($i) => mb_strtolower($i->author ?? '')),
            'views' => $items->sortByDesc('total_views'),
            'connected' => $items->sortByDesc('total_citations'),
            'lit' => $items->sortByDesc(fn($i) => ($i->total_citations ?? 0) + ($i->total_highlights ?? 0)),
            'added' => $items->sortByDesc('added_at'),
            'manual' => $items->sortBy('manual_position'),
            default => $items->sortByDesc('created_at'), // 'recent'
        };

        // No pin overlay for public view
        $items = $items->values();

        // Generate nodes using LibraryCardGenerator
        $generator = new LibraryCardGenerator();
        $chunks = [];
        $positionId = 100;

        foreach ($items as $i => $record) {
            $locked = ($record->book_visibility ?? 'public') !== 'public';
            $chunks[] = $generator->generateLibraryCardChunk($record, $syntheticBookId, $positionId, false, false, $i, 'public', $locked);
            $positionId++;
        }

        if ($items->isEmpty()) {
            $chunks[] = $generator->generateLibraryCardChunk(null, $syntheticBookId, 1, false, true, 0);
        }

        // Ensure library record exists for the synthetic book
        DB::connection('pgsql_admin')->table('library')->updateOrInsert(
            ['book' => $syntheticBookId],
            [
                'title' => $shelf->name,
                'visibility' => 'public',
                'listed' => false,
                'creator' => $shelf->creator,
                'creator_token' => null,
                'raw_json' => json_encode(['type' => 'shelf', 'shelf_id' => $id, 'sort' => $sort, 'public' => true]),
                'timestamp' => round(microtime(true) * 1000),
                'updated_at' => now(),
                'created_at' => now(),
            ]
        );

        // Insert nodes
        DB::connection('pgsql_admin')->table('nodes')->where('book', $syntheticBookId)->delete();
        foreach (array_chunk($chunks, 500) as $batch) {
            DB::connection('pgsql_admin')->table('nodes')->insert($batch);
        }

        return response()->json(['bookId' => $syntheticBookId]);
    }

    /**
     * Public full-text search within a public shelf's books (no auth required).
     * Only searches public books in the shelf.
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
        $tsQuery = $searchService->buildTsQuery($query);

        if (empty($tsQuery)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        // Only search public books in the shelf
        $books = DB::connection('pgsql_admin')->table('shelf_items')
            ->join('library', 'shelf_items.book', '=', 'library.book')
            ->where('shelf_items.shelf_id', $id)
            ->where('library.visibility', 'public')
            ->pluck('library.book')
            ->toArray();

        if (empty($books)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        // Two-stage search: exact first, fallback to stemmed
        $results = $this->executeShelfNodeSearch($tsQuery, 'simple', 'search_vector_simple', $books, $limit);
        $searchType = 'exact';

        if ($results->isEmpty()) {
            $results = $this->executeShelfNodeSearch($tsQuery, 'english', 'search_vector', $books, $limit);
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
        $results = $this->executeShelfNodeSearch($tsQuery, 'simple', 'search_vector_simple', $books, $limit);
        $searchType = 'exact';

        if ($results->isEmpty()) {
            $results = $this->executeShelfNodeSearch($tsQuery, 'english', 'search_vector', $books, $limit);
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
     * Public full-text search within a user's public library (no auth required).
     * GET /api/public/library/{username}/search?q=query
     */
    public function publicSystemSearch(Request $request, string $username)
    {
        $user = \App\Models\User::findByNamePublic($username);
        if (!$user) {
            return response()->json(['error' => 'User not found'], 404);
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

        // Only search public books belonging to this user
        $books = DB::connection('pgsql_admin')->table('library')
            ->where('creator', $user->name)
            ->where('visibility', 'public')
            ->whereRaw("book NOT LIKE '%/%'")
            ->pluck('book')
            ->toArray();

        if (empty($books)) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
            ]);
        }

        // Two-stage search: exact first, fallback to stemmed
        $results = $this->executeShelfNodeSearch($tsQuery, 'simple', 'search_vector_simple', $books, $limit);
        $searchType = 'exact';

        if ($results->isEmpty()) {
            $results = $this->executeShelfNodeSearch($tsQuery, 'english', 'search_vector', $books, $limit);
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

    // Allowed values for SQL interpolation
    private const ALLOWED_CONFIGS = ['simple', 'english'];
    private const ALLOWED_VECTOR_COLUMNS = ['search_vector', 'search_vector_simple'];

    /**
     * Execute node search scoped to a specific set of books.
     */
    protected function executeShelfNodeSearch(string $tsQuery, string $config, string $vectorColumn, array $books, int $limit)
    {
        if (!in_array($config, self::ALLOWED_CONFIGS, true)) {
            throw new \InvalidArgumentException("Invalid search config: {$config}");
        }
        if (!in_array($vectorColumn, self::ALLOWED_VECTOR_COLUMNS, true)) {
            throw new \InvalidArgumentException("Invalid vector column: {$vectorColumn}");
        }

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
                    nodes.{$vectorColumn} AS vec
                FROM nodes
                JOIN library ON nodes.book = library.book
                WHERE nodes.{$vectorColumn} @@ to_tsquery('{$config}', ?)
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
