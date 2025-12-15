<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;

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
            // Convert search query to tsquery format
            $tsQuery = $this->buildTsQuery($query);

            if (empty($tsQuery)) {
                return response()->json([
                    'success' => true,
                    'results' => [],
                    'query' => $query,
                    'mode' => 'library'
                ]);
            }

            // Build the base query
            $dbQuery = DB::table('library')
                ->selectRaw("
                    book,
                    title,
                    author,
                    ts_rank(search_vector, to_tsquery('english', ?)) as relevance,
                    ts_headline('english', COALESCE(title, '') || ' - ' || COALESCE(author, ''),
                        to_tsquery('english', ?),
                        'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
                    ) as headline
                ", [$tsQuery, $tsQuery])
                ->whereRaw("search_vector @@ to_tsquery('english', ?)", [$tsQuery]);

            // Apply visibility filter: public books + user's own books
            $this->applyVisibilityFilter($dbQuery, $request);

            $results = $dbQuery
                ->orderByDesc('relevance')
                ->limit($limit)
                ->get();

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
     * Search nodes (plainText content) - Full-text mode
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

            // Search nodes and join with library for metadata
            $dbQuery = DB::table('nodes')
                ->join('library', 'nodes.book', '=', 'library.book')
                ->selectRaw("
                    nodes.book,
                    nodes.node_id,
                    nodes.\"startLine\",
                    library.title,
                    library.author,
                    ts_rank(nodes.search_vector, to_tsquery('english', ?)) as relevance,
                    ts_headline('english', COALESCE(nodes.\"plainText\", nodes.content, ''),
                        to_tsquery('english', ?),
                        'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
                    ) as headline
                ", [$tsQuery, $tsQuery])
                ->whereRaw("nodes.search_vector @@ to_tsquery('english', ?)", [$tsQuery])
                // Exclude homepage aggregation books
                ->whereNotIn('nodes.book', ['most-recent', 'most-connected', 'most-lit']);

            // Apply visibility filter on the joined library table
            $this->applyVisibilityFilter($dbQuery, $request, 'library');

            $results = $dbQuery
                ->orderByDesc('relevance')
                ->limit($limit)
                ->get();

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
                        'headline' => $r->headline,
                        'relevance' => $r->relevance
                    ])->values()
                ];
            })->values();

            return response()->json([
                'success' => true,
                'results' => $groupedResults,
                'query' => $query,
                'mode' => 'fulltext',
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
                    ->where("{$prefix}visibility", '!=', 'private');
            });

            // OR user's own books (if logged in)
            if ($user) {
                $q->orWhere("{$prefix}creator", $user->name);
            }

            // OR anonymous user's own books (if has token)
            if ($anonymousToken) {
                $q->orWhere("{$prefix}creator_token", $anonymousToken);
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
                $words = array_filter($words, fn($w) => strlen($w) >= 2);
                if (!empty($words)) {
                    $phraseQuery = implode(' <-> ', $words);
                    $query = str_replace('"' . $phrase . '"', '(' . $phraseQuery . ')', $query);
                }
            }
        }

        // Split remaining terms and join with &
        $terms = preg_split('/\s+/', $query);
        $terms = array_filter($terms, fn($t) => strlen($t) >= 2);

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
