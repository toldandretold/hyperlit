<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use App\Http\Controllers\OpenAlexController;

class SearchController extends Controller
{
    private const MAX_RESULTS = 50;

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
                return $arr;
            })->values()->all();

            // 2. Supplement with OpenAlex if fewer than 10 library hits
            $openAlexResults = [];
            $openAlexFull = false;
            if (count($libraryResults) < 10) {
                $openAlexLimit = max(10 - count($libraryResults), 5);
                $openAlexController = new OpenAlexController();
                $candidates = $openAlexController->fetchFromOpenAlex($query, $openAlexLimit, $openAlexPage);
                $openAlexFull = count($candidates) >= $openAlexLimit;

                // Deduplicate against library results by normalised title
                $libraryTitles = array_map(
                    fn($r) => strtolower(trim($r['title'] ?? '')),
                    $libraryResults
                );

                $deduplicated = [];
                foreach ($candidates as $candidate) {
                    $t = strtolower(trim($candidate['title'] ?? ''));
                    if ($t !== '' && !in_array($t, $libraryTitles, true)) {
                        $deduplicated[] = $candidate;
                    }
                }

                // Upsert deduplicated results as library stubs so they're immediately insertable
                if (!empty($deduplicated)) {
                    $openAlexResults = $openAlexController->upsertLibraryStubs(
                        $deduplicated,
                        Auth::id(),
                        $request->cookie('anon_token')
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
     */
    private function runLibrarySearch(Request $request, string $query, int $limit, int $offset = 0): ?\Illuminate\Support\Collection
    {
        $tsQuery = $this->buildTsQuery($query);

        if (empty($tsQuery)) {
            return null;
        }

        // Using 'simple' config to match the search_vector (preserves stop words)
        $dbQuery = DB::table('library')
            ->selectRaw("
                book,
                title,
                author,
                bibtex,
                has_nodes,
                ts_rank(search_vector, to_tsquery('simple', ?)) as relevance,
                ts_headline('simple',
                    COALESCE(title, '') || ' ' || COALESCE(author, '') || ' ' ||
                    COALESCE(booktitle, '') || ' ' || COALESCE(chapter, '') || ' ' || COALESCE(editor, ''),
                    to_tsquery('simple', ?),
                    'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
                ) as headline
            ", [$tsQuery, $tsQuery])
            ->whereRaw("search_vector @@ to_tsquery('simple', ?)", [$tsQuery]);

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

            // Check if simple config has matches and if it's a high-frequency term
            $simpleCheck = $this->checkNodeMatches($tsQuery, 'simple', 'search_vector_simple');

            if ($simpleCheck['has_match']) {
                $results = $this->executeNodeSearch($request, $tsQuery, 'simple', 'search_vector_simple', $limit, $simpleCheck['is_high_frequency']);
                $searchType = 'exact';
            } else {
                // Fallback to english - check if high frequency
                $englishCheck = $this->checkNodeMatches($tsQuery, 'english', 'search_vector');
                $results = $this->executeNodeSearch($request, $tsQuery, 'english', 'search_vector', $limit, $englishCheck['is_high_frequency']);
                $searchType = 'stemmed';
            }

            // Group results by book for better UX
            $groupedResults = $results->groupBy('book')->map(function ($bookResults) {
                $first = $bookResults->first();
                return [
                    'book' => $first->book,
                    'title' => $first->title,
                    'author' => $first->author,
                    'matches' => $bookResults->map(fn($r) => [
                        'node_id' => $r->node_id,
                        'startLine' => $r->startLine,
                        'headline' => $r->headline
                    ])->values()
                ];
            })->values();

            return response()->json([
                'success' => true,
                'results' => $groupedResults,
                'query' => $query,
                'mode' => 'fulltext',
                'search_type' => $searchType,
                'count' => $results->count()
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
     * Check if matches exist and estimate if it's a high-frequency term
     * Returns: ['has_match' => bool, 'is_high_frequency' => bool]
     */
    private function checkNodeMatches(string $tsQuery, string $config, string $vectorColumn): array
    {
        // 🔒 SECURITY: Validate config and vectorColumn against whitelist
        if (!in_array($config, self::ALLOWED_CONFIGS, true)) {
            throw new \InvalidArgumentException("Invalid search config: {$config}");
        }
        if (!in_array($vectorColumn, self::ALLOWED_VECTOR_COLUMNS, true)) {
            throw new \InvalidArgumentException("Invalid vector column: {$vectorColumn}");
        }

        // Check if we get more than 1000 results quickly (high-frequency threshold)
        // Using LIMIT 1001 and counting - if we hit 1001, it's high frequency
        $result = DB::selectOne("
            SELECT COUNT(*) as cnt FROM (
                SELECT 1 FROM nodes
                WHERE {$vectorColumn} @@ to_tsquery('{$config}', ?)
                AND book NOT IN ('most-recent', 'most-connected', 'most-lit')
                LIMIT 1001
            ) sub
        ", [$tsQuery]);

        $count = $result->cnt ?? 0;

        return [
            'has_match' => $count > 0,
            'is_high_frequency' => $count > 1000
        ];
    }

    /**
     * Execute node search with specified text search configuration
     * Uses subquery to LIMIT first, then compute ts_headline only for matched rows
     * Skips ORDER BY for high-frequency terms to maintain speed
     */
    private function executeNodeSearch(Request $request, string $tsQuery, string $config, string $vectorColumn, int $limit, bool $isHighFrequency = false)
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

        // Build visibility conditions
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

        // Skip ORDER BY for high-frequency terms (>1000 matches) - too slow
        $orderClause = $isHighFrequency ? '' : 'ORDER BY library.created_at DESC';

        // Use subquery: first get top N rows, THEN compute headline
        // This avoids computing ts_headline for all matching rows
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
                    library.created_at,
                    COALESCE(nodes.\"plainText\", nodes.content, '') as text_content
                FROM nodes
                JOIN library ON nodes.book = library.book
                WHERE nodes.{$vectorColumn} @@ to_tsquery('{$config}', ?)
                    AND nodes.book NOT IN ('most-recent', 'most-connected', 'most-lit')
                    AND {$visibilityClause}
                {$orderClause}
                LIMIT ?
            ) sub
        ";

        $params = array_merge(
            [$tsQuery, $tsQuery],
            $visibilityParams,
            [$limit]
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
     * Convert user query to PostgreSQL tsquery format
     * Handles phrase search with quotes and joins terms with &
     */
    private function buildTsQuery(string $query): string
    {
        // Sanitize the query
        $query = trim($query);

        if (empty($query)) {
            return '';
        }

        // Handle quoted phrases - convert "exact phrase" to 'exact <-> phrase'
        if (preg_match_all('/"([^"]+)"/', $query, $matches)) {
            foreach ($matches[1] as $phrase) {
                $words = preg_split('/\s+/', trim($phrase));
                $words = array_filter($words, fn($w) => strlen($w) >= 1);
                if (!empty($words)) {
                    $phraseQuery = implode(' <-> ', $words);
                    $query = str_replace('"' . $phrase . '"', '(' . $phraseQuery . ')', $query);
                }
            }
        }

        // Split remaining terms and join with &
        $terms = preg_split('/\s+/', $query);
        $terms = array_filter($terms, fn($t) => strlen($t) >= 1);

        if (empty($terms)) {
            return '';
        }

        // Clean terms and add prefix matching to last term for autocomplete behavior
        $lastIndex = count($terms) - 1;
        $processed = [];

        foreach (array_values($terms) as $index => $term) {
            // Remove special characters except those used in phrase queries
            $term = preg_replace('/[^\w\s\-<>()]/', '', $term);

            if (empty($term)) {
                continue;
            }

            // Add prefix matching to last term for autocomplete-like behavior
            if ($index === $lastIndex && !str_contains($term, '<->')) {
                $processed[] = $term . ':*';
            } else {
                $processed[] = $term;
            }
        }

        if (empty($processed)) {
            return '';
        }

        return implode(' & ', $processed);
    }
}
