<?php

namespace App\Http\Controllers;

use App\Services\SearchService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use App\Services\OpenAlexService;

class SearchController extends Controller
{
    private const MAX_RESULTS = 50;

    public function __construct(
        private SearchService $searchService,
    ) {}

    /**
     * Search library (title + author) - Default mode
     */
    public function searchLibrary(Request $request)
    {
        $query = $request->input('q', '');
        $limit = min($request->input('limit', 20), self::MAX_RESULTS);

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
                'mode' => 'library'
            ]);
        }

        try {
            $results = $this->runLibrarySearch($request, $query, $limit);

            if ($results === null) {
                return response()->json([
                    'success' => true,
                    'results' => [],
                    'query' => $query,
                    'mode' => 'library'
                ]);
            }

            return response()->json([
                'success' => true,
                'results' => $results,
                'query' => $query,
                'mode' => 'library',
                'count' => $results->count()
            ]);

        } catch (\Exception $e) {
            Log::error('Library search failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Search failed',
                'error' => config('app.debug') ? $e->getMessage() : null
            ], 500);
        }
    }

    /**
     * Combined library + OpenAlex search
     * GET /api/search/combined?q=query&limit=15
     *
     * Returns library results first; if fewer than 10, supplements with OpenAlex.
     */
    public function searchWithOpenAlex(Request $request)
    {
        $query = $request->input('q', '');
        $limit = min((int) $request->input('limit', 15), self::MAX_RESULTS);
        $offset = max(0, (int) $request->input('offset', 0));
        $openAlexPage = (int) floor($offset / $limit) + 1;

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query'   => $query,
                'mode'    => 'combined',
            ]);
        }

        try {
            // 1. Library results (paginated via SQL offset)
            $libraryCollection = $this->runLibrarySearch($request, $query, $limit, $offset) ?? collect();

            $libraryResults = $libraryCollection->map(function ($row) {
                $arr = (array) $row;
                $arr['source'] = 'library';
                $arr['has_nodes'] = (bool) ($arr['has_nodes'] ?? true);
                return $arr;
            })->values()->all();

            // 2. Supplement with OpenAlex if fewer than 10 library hits
            $openAlexResults = [];
            $openAlexFull = false;
            if (count($libraryResults) < 10) {
                $openAlexLimit = max(10 - count($libraryResults), 5);
                $openAlexService = app(OpenAlexService::class);

                // Fetch title-based and author-based results in parallel
                $titleCandidates = $openAlexService->fetchFromOpenAlex($query, $openAlexLimit, $openAlexPage);
                $authorCandidates = $openAlexService->fetchFromOpenAlexByAuthor($query, $openAlexLimit);

                // Merge: author results first, dedup by openalex_id
                $seenIds = [];
                $merged = [];
                foreach (array_merge($authorCandidates, $titleCandidates) as $candidate) {
                    $oaId = $candidate['openalex_id'] ?? null;
                    if ($oaId && isset($seenIds[$oaId])) {
                        continue;
                    }
                    if ($oaId) {
                        $seenIds[$oaId] = true;
                    }
                    $merged[] = $candidate;
                }

                $openAlexFull = count($titleCandidates) >= $openAlexLimit;

                // Deduplicate against library results by normalised title
                $libraryTitles = array_map(
                    fn($r) => strtolower(trim($r['title'] ?? '')),
                    $libraryResults
                );

                $deduplicated = [];
                foreach ($merged as $candidate) {
                    $t = strtolower(trim($candidate['title'] ?? ''));
                    if ($t !== '' && !in_array($t, $libraryTitles, true)) {
                        $deduplicated[] = $candidate;
                    }
                }

                // Upsert deduplicated results as library stubs so they're immediately insertable
                if (!empty($deduplicated)) {
                    $openAlexResults = $openAlexService->upsertLibraryStubs(
                        $deduplicated
                    );
                }
            }

            $results = array_merge($libraryResults, $openAlexResults);

            return response()->json([
                'success'  => true,
                'results'  => $results,
                'query'    => $query,
                'mode'     => 'combined',
                'count'    => count($results),
                'has_more' => count($libraryResults) >= $limit || $openAlexFull,
                'offset'   => $offset,
            ]);

        } catch (\Exception $e) {
            Log::error('Combined search failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Search failed',
                'error'   => config('app.debug') ? $e->getMessage() : null,
            ], 500);
        }
    }

    /**
     * Execute the library full-text search and return the raw collection (or null on empty tsquery).
     * Falls back to OR matching when AND returns 0 results for multi-term queries (first page only).
     */
    private function runLibrarySearch(Request $request, string $query, int $limit, int $offset = 0): ?\Illuminate\Support\Collection
    {
        $tsQuery = $this->buildTsQuery($query);

        if (empty($tsQuery)) {
            return null;
        }

        $results = $this->executeLibraryQuery($request, $tsQuery, $limit, $offset);

        // OR fallback: when AND returns 0 results, has multiple terms, and is first page
        if ($results->isEmpty() && $offset === 0 && str_contains($tsQuery, ' & ')) {
            $orQuery = str_replace(' & ', ' | ', $tsQuery);
            $results = $this->executeLibraryQuery($request, $orQuery, $limit, $offset);
        }

        return $results;
    }

    /**
     * Build and execute the library full-text query for a given tsquery string.
     */
    private function executeLibraryQuery(Request $request, string $tsQuery, int $limit, int $offset): \Illuminate\Support\Collection
    {
        // Using 'simple' config to match the search_vector (preserves stop words)
        $dbQuery = DB::table('library')
            ->selectRaw("
                book,
                title,
                author,
                bibtex,
                has_nodes,
                ts_rank('{0.05, 0.1, 0.3, 1.0}', search_vector, to_tsquery('simple', ?)) as relevance,
                ts_headline('simple',
                    COALESCE(title, '') || ' ' || COALESCE(author, '') || ' ' ||
                    COALESCE(booktitle, '') || ' ' || COALESCE(chapter, '') || ' ' ||
                    COALESCE(editor, '') || ' ' || COALESCE(year, ''),
                    to_tsquery('simple', ?),
                    'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
                ) as headline
            ", [$tsQuery, $tsQuery])
            ->whereRaw("search_vector @@ to_tsquery('simple', ?)", [$tsQuery])
            ->whereRaw("book NOT LIKE '%/%'"); // exclude footnote/highlight sub-books

        $this->applyVisibilityFilter($dbQuery, $request);

        return $dbQuery
            ->orderByDesc('relevance')
            ->skip($offset)
            ->limit($limit)
            ->get();
    }

    /**
     * Search nodes (plainText content) - Full-text mode
     * Uses exact matching first (simple), falls back to stemmed (english) if no results
     */
    public function searchNodes(Request $request)
    {
        $query = $request->input('q', '');
        $limit = min($request->input('limit', 20), self::MAX_RESULTS);

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
                'mode' => 'fulltext'
            ]);
        }

        try {
            $tsQuery = $this->buildTsQuery($query);

            if (empty($tsQuery)) {
                return response()->json([
                    'success' => true,
                    'results' => [],
                    'query' => $query,
                    'mode' => 'fulltext'
                ]);
            }

            $userKey = Auth::id() ?? $request->cookie('anon_token') ?? 'guest';
            $cacheKey = "search:nodes:{$userKey}:{$tsQuery}:{$limit}";

            $payload = Cache::remember($cacheKey, 60, function () use ($request, $tsQuery, $limit) {
                $results = $this->executeNodeSearch($request, $tsQuery, 'simple', 'search_vector_simple', $limit);
                $searchType = 'exact';

                if ($results->isEmpty()) {
                    $results = $this->executeNodeSearch($request, $tsQuery, 'english', 'search_vector', $limit);
                    $searchType = 'stemmed';
                }

                $groupedResults = $results->groupBy('book')->map(function ($bookResults) {
                    $first = $bookResults->first();
                    $isSubbook = (bool) $first->is_subbook;
                    return [
                        'book' => $first->book,
                        'title' => $first->title,
                        'author' => $first->author,
                        'is_subbook' => $isSubbook,
                        'subbook_kind' => $isSubbook ? $first->subbook_kind : null,
                        'parent_book' => $isSubbook ? $first->parent_book : null,
                        'parent_title' => $isSubbook ? $first->parent_title : null,
                        'parent_author' => $isSubbook ? $first->parent_author : null,
                        'matches' => $bookResults->map(fn($r) => [
                            'node_id' => $r->node_id,
                            'startLine' => $r->startLine,
                            'headline' => $r->headline
                        ])->values()
                    ];
                })->values();

                return [
                    'results' => $groupedResults,
                    'search_type' => $searchType,
                    'count' => $results->count(),
                ];
            });

            return response()->json([
                'success' => true,
                'results' => $payload['results'],
                'query' => $query,
                'mode' => 'fulltext',
                'search_type' => $payload['search_type'],
                'count' => $payload['count'],
            ]);

        } catch (\Exception $e) {
            Log::error('Nodes search failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Search failed',
                'error' => config('app.debug') ? $e->getMessage() : null
            ], 500);
        }
    }

    // 🔒 SECURITY: Whitelist allowed values to prevent SQL injection
    private const ALLOWED_CONFIGS = ['simple', 'english'];
    private const ALLOWED_VECTOR_COLUMNS = ['search_vector', 'search_vector_simple'];

    /**
     * Execute node search with specified text search configuration.
     *
     * Uses a subquery to LIMIT first (by ts_rank_cd) so ts_headline only runs
     * on the top N rows. Joins library twice: once for the matched book's own
     * row (for visibility filtering) and once via split_part(book, '/', 1)
     * to surface the foundation book's title/author for sub-book results.
     */
    private function executeNodeSearch(Request $request, string $tsQuery, string $config, string $vectorColumn, int $limit)
    {
        // 🔒 SECURITY: Validate config and vectorColumn against whitelist
        if (!in_array($config, self::ALLOWED_CONFIGS, true)) {
            throw new \InvalidArgumentException("Invalid search config: {$config}");
        }
        if (!in_array($vectorColumn, self::ALLOWED_VECTOR_COLUMNS, true)) {
            throw new \InvalidArgumentException("Invalid vector column: {$vectorColumn}");
        }

        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        $visibilityConditions = ["(library.listed = true AND library.visibility NOT IN ('private', 'deleted'))"];
        $visibilityParams = [];

        if ($user) {
            $visibilityConditions[] = "(library.creator = ? AND library.visibility != 'deleted')";
            $visibilityParams[] = $user->name;
        }

        if ($anonymousToken) {
            $visibilityConditions[] = "(library.creator_token = ? AND library.visibility != 'deleted')";
            $visibilityParams[] = $anonymousToken;
        }

        $visibilityClause = '(' . implode(' OR ', $visibilityConditions) . ')';

        // Two-stage: inner subquery uses no ORDER BY so the GIN scan can
        // stream-and-stop at LIMIT (cheap regardless of match cardinality).
        // Outer query computes ts_headline + ts_rank_cd on just those rows
        // and orders them by relevance (cheap — only $limit rows).
        $sql = "
            SELECT
                sub.book,
                sub.node_id,
                sub.\"startLine\",
                sub.title,
                sub.author,
                sub.is_subbook,
                sub.subbook_kind,
                sub.parent_book,
                sub.parent_title,
                sub.parent_author,
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
                    (nodes.book LIKE '%/%') AS is_subbook,
                    CASE WHEN nodes.book ~ 'HL_[^/]*\$' THEN 'highlight' ELSE 'footnote' END AS subbook_kind,
                    split_part(nodes.book, '/', 1) AS parent_book,
                    parent_lib.title AS parent_title,
                    parent_lib.author AS parent_author,
                    COALESCE(nodes.\"plainText\", nodes.content, '') as text_content,
                    nodes.{$vectorColumn} AS vec
                FROM nodes
                JOIN library ON nodes.book = library.book
                LEFT JOIN library AS parent_lib
                    ON nodes.book LIKE '%/%'
                    AND parent_lib.book = split_part(nodes.book, '/', 1)
                WHERE nodes.{$vectorColumn} @@ to_tsquery('{$config}', ?)
                    AND nodes.book NOT IN ('most-recent', 'most-connected', 'most-lit')
                    AND {$visibilityClause}
                LIMIT ?
            ) sub
            ORDER BY ts_rank_cd(sub.vec, to_tsquery('{$config}', ?)) DESC
        ";

        $params = array_merge(
            [$tsQuery, $tsQuery],
            $visibilityParams,
            [$limit, $tsQuery]
        );

        return collect(DB::select($sql, $params));
    }

    /**
     * Apply visibility filter: show public listed books + user's own books
     */
    private function applyVisibilityFilter($query, Request $request, string $tableAlias = null): void
    {
        $prefix = $tableAlias ? "{$tableAlias}." : '';

        // Get current user info
        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        $query->where(function ($q) use ($prefix, $user, $anonymousToken) {
            // Public and listed books
            $q->where(function ($publicQuery) use ($prefix) {
                $publicQuery->where("{$prefix}listed", true)
                    ->whereNotIn("{$prefix}visibility", ['private', 'deleted']);
            });

            // OR user's own books (if logged in) - excluding deleted
            if ($user) {
                $q->orWhere(function ($userQuery) use ($prefix, $user) {
                    $userQuery->where("{$prefix}creator", $user->name)
                        ->where("{$prefix}visibility", '!=', 'deleted');
                });
            }

            // OR anonymous user's own books (if has token) - excluding deleted
            if ($anonymousToken) {
                $q->orWhere(function ($anonQuery) use ($prefix, $anonymousToken) {
                    $anonQuery->where("{$prefix}creator_token", $anonymousToken)
                        ->where("{$prefix}visibility", '!=', 'deleted');
                });
            }
        });
    }

    /**
     * Delegate to shared SearchService for tsquery building.
     */
    private function buildTsQuery(string $query): string
    {
        return $this->searchService->buildTsQuery($query);
    }
}
