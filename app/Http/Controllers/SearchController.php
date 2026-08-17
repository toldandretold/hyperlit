<?php

namespace App\Http\Controllers;

use App\Services\CitationSearchService;
use App\Services\EmbeddingService;
use App\Services\SearchService;
use Illuminate\Database\QueryException;
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
        private CitationSearchService $citationSearchService,
        private EmbeddingService $embeddingService,
    ) {}

    /**
     * Search library (title + author) - Default mode
     */
    public function searchLibrary(Request $request)
    {
        $query = $request->input('q', '');
        $limit = max(1, min((int) $request->input('limit', 20), self::MAX_RESULTS));

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
                'mode' => 'library'
            ]);
        }

        try {
            $t = hrtime(true);
            $results = $this->runLibrarySearch($request, $query, $limit);
            $dbMs = round((hrtime(true) - $t) / 1e6, 1);

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
            ])->header('Server-Timing', $this->serverTimingHeader(['db_ms' => $dbMs]));

        } catch (QueryException $qe) {
            // Malformed full-text query (to_tsquery syntax error). The query is
            // parameterised, so this is NOT injection — return a graceful 422 instead
            // of leaking a 500.
            if (in_array($qe->getCode(), ['42601', '22023'], true)) {
                return response()->json(['success' => false, 'message' => 'Invalid search query'], 422);
            }
            Log::error('Search query error: ' . $qe->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Search failed',
                'error' => config('app.debug') ? $qe->getMessage() : null,
            ], 500);
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
     * Hybrid citation search.
     * GET /api/search/combined?q=query&limit=15&sourceScope=public|mine|shelf&shelfId=...
     *
     * Returns a single ranked list of mixed result shapes:
     *   - canonical (with linked library version(s)) — `book` = best library version
     *   - canonical-only (no library version yet)    — `book` = empty, citation-only flow
     *   - library (orphan, user import, no canonical) — `book` = library.book
     *
     * On public scope and thin local results, supplements by ingesting OpenAlex +
     * Open Library results into canonical_source (NOT library), then re-runs the
     * hybrid query so the new canonicals fold into the result set.
     */
    public function searchWithOpenAlex(Request $request)
    {
        $query  = $request->input('q', '');
        $limit  = min((int) $request->input('limit', 15), self::MAX_RESULTS);
        $offset = max(0, (int) $request->input('offset', 0));

        // Scope contract mirrors AiBrainController::query (locked by AiBrainScopeValidationTest).
        // Default 'public' preserves existing behaviour for callers that don't pass scope.
        try {
            $scopeValidated = $request->validate([
                'sourceScope' => 'nullable|string|in:public,mine,shelf',
                'shelfId'     => 'nullable|string|uuid',
            ]);
        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        }

        $sourceScope = $scopeValidated['sourceScope'] ?? 'public';
        $shelfId     = $scopeValidated['shelfId'] ?? null;

        if ($sourceScope === 'shelf') {
            if (!$shelfId) {
                return response()->json(['success' => false, 'message' => 'shelfId is required when sourceScope=shelf'], 422);
            }
            $user = Auth::user();
            if (!$user) {
                return response()->json(['success' => false, 'message' => 'Authentication required for shelf scope'], 401);
            }
            $owned = DB::table('shelves')->where('id', $shelfId)->where('creator', $user->name)->exists();
            if (!$owned) {
                return response()->json(['success' => false, 'message' => 'Shelf not found or not yours'], 404);
            }
        }

        if (strlen($query) < 2) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query'   => $query,
                'mode'    => 'combined',
            ]);
        }

        try {
            $user = Auth::user();
            $payload = $this->citationSearchService->search(
                query:       $query,
                limit:       $limit,
                offset:      $offset,
                sourceScope: $sourceScope,
                shelfId:     $shelfId,
                creatorName: $user?->name,
            );

            $results = array_map(
                fn($row) => $this->shapeCitationResult($row),
                $payload['results']
            );

            $timings = $payload['timings'] ?? [];
            $totalMs = array_sum($timings);
            if ($totalMs > 500) {
                Log::info('citation_search.timings', ['query' => $query, 'timings' => $timings]);
            }

            return response()->json([
                'success'           => true,
                'results'           => $results,
                'query'             => $query,
                'mode'              => 'combined',
                'count'             => count($results),
                'has_more'          => $payload['has_more'],
                'offset'            => $offset,
                'external_ingested' => $payload['external_ingested'], // deprecated: always 0, use external_pending
                'external_pending'  => $payload['external_pending'],
                'external_status'   => $payload['external_status'],
            ])->header('Server-Timing', $this->serverTimingHeader($timings));

        } catch (QueryException $qe) {
            // Malformed full-text query (to_tsquery syntax error). The query is
            // parameterised, so this is NOT injection — return a graceful 422 instead
            // of leaking a 500.
            if (in_array($qe->getCode(), ['42601', '22023'], true)) {
                return response()->json(['success' => false, 'message' => 'Invalid search query'], 422);
            }
            Log::error('Search query error: ' . $qe->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Search failed',
                'error' => config('app.debug') ? $qe->getMessage() : null,
            ], 500);
        } catch (\Exception $e) {
            Log::error('Combined search failed: ' . $e->getMessage(), [
                'trace' => $e->getTraceAsString(),
            ]);
            return response()->json([
                'success' => false,
                'message' => 'Search failed',
                'error'   => config('app.debug') ? $e->getMessage() : null,
            ], 500);
        }
    }

    /**
     * Shape a hybrid-search row for the citation modal frontend.
     *
     * - canonical with version: `book` = best library version, navigates on click
     * - canonical-only: `book` = '', `canonical_source_id` populated; PR5 resolver
     *   surfaces the citation-card UI on click
     * - library orphan: `book` = library.book, current navigation behaviour
     *
     * `source` discriminates the three shapes for the renderer; `has_nodes` is
     * preserved so existing "no text link" badge logic keeps working.
     */
    private function shapeCitationResult(\stdClass $row): array
    {
        $isCanonical = $row->row_type === 'canonical';
        $hasVersion = (bool) ($row->has_version ?? false);

        $book = $isCanonical
            ? (string) ($row->best_version_book ?? '')   // empty when canonical-only
            : (string) $row->id;

        return [
            'row_type'            => $row->row_type,
            'id'                  => (string) $row->id,
            'book'                => $book,
            'canonical_source_id' => $isCanonical ? (string) $row->id : null,
            'title'               => $row->title,
            'author'              => $row->author,
            'year'                => $row->year,
            'journal'             => $row->journal,
            'bibtex'              => $row->bibtex,
            'has_version'         => $hasVersion,
            'has_nodes'           => $hasVersion,  // alias for existing display logic
            'is_private'          => (bool) ($row->is_private ?? false),
            'source'              => $isCanonical
                ? ($hasVersion ? 'canonical' : 'canonical-only')
                : 'library',
        ];
    }

    /**
     * Execute the library full-text search and return the raw collection (or null on empty tsquery).
     * Falls back to OR matching when AND returns 0 results for multi-term queries (first page only).
     *
     * $sourceScope = null preserves the legacy "public listed + caller's own books" union
     * used by /api/search/library (the deprecated path). Passing 'public' / 'mine' / 'shelf'
     * switches to AiBrain-style scope filtering used by the citation modal.
     */
    private function runLibrarySearch(Request $request, string $query, int $limit, int $offset = 0, ?string $sourceScope = null, ?string $shelfId = null): ?\Illuminate\Support\Collection
    {
        $tsQuery = $this->buildTsQuery($query);

        if (empty($tsQuery)) {
            return null;
        }

        $results = $this->executeLibraryQuery($request, $tsQuery, $limit, $offset, $sourceScope, $shelfId);

        // OR fallback: when AND returns 0 results, has multiple terms, and is first page
        if ($results->isEmpty() && $offset === 0 && str_contains($tsQuery, ' & ')) {
            $orQuery = str_replace(' & ', ' | ', $tsQuery);
            $results = $this->executeLibraryQuery($request, $orQuery, $limit, $offset, $sourceScope, $shelfId);
        }

        return $results;
    }

    /**
     * Build and execute the library full-text query for a given tsquery string.
     */
    private function executeLibraryQuery(Request $request, string $tsQuery, int $limit, int $offset, ?string $sourceScope = null, ?string $shelfId = null): \Illuminate\Support\Collection
    {
        // Read-only search runs on the search connection (BYPASSRLS in prod —
        // see config/database.php 'search_read_connection'); visibility is
        // enforced explicitly by applyVisibilityFilter below, not by RLS.
        // Using 'simple' config to match the search_vector (preserves stop words)
        $dbQuery = DB::connection(config('database.search_read_connection'))->table('library')
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

        $this->applyVisibilityFilter($dbQuery, $request, null, $sourceScope, $shelfId);

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
        $limit = max(1, min((int) $request->input('limit', 20), self::MAX_RESULTS));

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

            $t = hrtime(true);
            $payload = Cache::remember($cacheKey, 60, function () use ($request, $tsQuery, $limit) {
                $results = $this->executeNodeSearch($request, $tsQuery, 'simple', $limit);
                $searchType = 'exact';

                if ($results->isEmpty()) {
                    $results = $this->executeNodeSearch($request, $tsQuery, 'english', $limit);
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

            $dbMs = round((hrtime(true) - $t) / 1e6, 1);

            return response()->json([
                'success' => true,
                'results' => $payload['results'],
                'query' => $query,
                'mode' => 'fulltext',
                'search_type' => $payload['search_type'],
                'count' => $payload['count'],
            ])->header('Server-Timing', $this->serverTimingHeader(['db_ms' => $dbMs]));

        } catch (QueryException $qe) {
            // Malformed full-text query (to_tsquery syntax error). The query is
            // parameterised, so this is NOT injection — return a graceful 422 instead
            // of leaking a 500.
            if (in_array($qe->getCode(), ['42601', '22023'], true)) {
                return response()->json(['success' => false, 'message' => 'Invalid search query'], 422);
            }
            Log::error('Search query error: ' . $qe->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Search failed',
                'error' => config('app.debug') ? $qe->getMessage() : null,
            ], 500);
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
     * Semantic search over node embeddings - opt-in homepage mode.
     *
     * Embeds the query via EmbeddingService (nomic 'search_query: ' prefix —
     * mandatory, the wrong prefix silently degrades recall), then runs a pure
     * cosine-distance HNSW scan (SearchService::buildSemanticNodeSearchQuery).
     * Free feature: per-query embedding cost is ~$0.00000008, covered by the
     * route throttle — deliberately NOT routed through BillingService (its
     * 0.0001 floor would over-bill ~1000× and guests have no billing path).
     */
    public function searchSemantic(Request $request)
    {
        $query = trim($request->input('q', ''));
        $limit = max(1, min((int) $request->input('limit', 20), self::MAX_RESULTS));

        // 3+ chars: shorter fragments embed to near-noise and each cache miss
        // costs an embedding API round-trip.
        if (mb_strlen($query) < 3) {
            return response()->json([
                'success' => true,
                'results' => [],
                'query' => $query,
                'mode' => 'semantic'
            ]);
        }

        try {
            $norm = mb_strtolower($query);

            // Query vectors are user-independent — cache 1h shared across all
            // users. Only cache on success: a null (provider outage) cached for
            // an hour would pin the 503 long after recovery.
            $vecCacheKey = 'search:semantic:vec:' . md5($norm);
            $embedMs = 0.0;
            $queryEmbedding = Cache::get($vecCacheKey);
            if ($queryEmbedding === null) {
                $t = hrtime(true);
                $queryEmbedding = $this->embeddingService->embed($norm, 'search_query: ', maxRetries: 1);
                $embedMs = round((hrtime(true) - $t) / 1e6, 1);
                if ($queryEmbedding === null) {
                    return response()->json([
                        'success' => false,
                        'message' => 'Semantic search is temporarily unavailable',
                    ], 503);
                }
                Cache::put($vecCacheKey, $queryEmbedding, 3600);
            }

            $userKey = Auth::id() ?? $request->cookie('anon_token') ?? 'guest';
            $cacheKey = 'search:semantic:' . $userKey . ':' . md5($norm) . ':' . $limit;

            $t = hrtime(true);
            $payload = Cache::remember($cacheKey, 60, function () use ($request, $queryEmbedding, $limit) {
                $visibleBooks = $this->searchService->getVisibleSemanticSearchBooks(
                    Auth::user()?->name,
                    $request->cookie('anon_token'),
                );

                [$sql, $params] = $this->searchService->buildSemanticNodeSearchQuery(
                    $queryEmbedding,
                    $limit,
                    $visibleBooks,
                );

                // Search connection (BYPASSRLS): the visibility clause inside
                // the query is the only access guard — see buildSemanticNodeSearchQuery.
                //
                // iterative_scan (pgvector ≥0.8) is REQUIRED for correctness,
                // not a tuning knob: without it the HNSW scan emits at most
                // hnsw.ef_search (40) tuples, so a query whose nearest raw
                // neighbours are dominated by filtered-out nodes under-fills
                // ("marxism" reproduced this — see the builder's doc block).
                // relaxed_order is fine — the outer query re-orders by
                // distance. SET LOCAL needs the transaction.
                $conn = DB::connection(config('database.search_read_connection'));
                $rows = $conn->transaction(function () use ($conn, $sql, $params) {
                    $conn->statement('SET LOCAL hnsw.iterative_scan = relaxed_order');
                    return $conn->select($sql, $params);
                });

                // Distance cutoff applied here, not in SQL, to keep the HNSW
                // ordered scan clean.
                $maxDistance = (float) config('services.llm.semantic_max_distance');

                // Floor-only rescale for the badge (see the config comment):
                // shifts the zero point to the measured noise floor, top stays
                // a true 100%. `similarity` stays raw for API consumers.
                $matchFloor = min((float) config('services.llm.semantic_match_floor'), 0.99);

                $results = collect($rows)
                    ->filter(fn ($r) => (float) $r->distance <= $maxDistance)
                    ->map(function ($r) use ($matchFloor) {
                        $sim = 1 - (float) $r->distance;
                        return [
                            'book' => $r->book,
                            'node_id' => $r->node_id,
                            'startLine' => $r->startLine,
                            'title' => $r->title,
                            'author' => $r->author,
                            'excerpt' => $r->excerpt,
                            'similarity' => round($sim, 3),
                            'match' => (int) round(max(0, ($sim - $matchFloor) / (1 - $matchFloor)) * 100),
                        ];
                    })->values();

                return ['results' => $results, 'count' => $results->count()];
            });
            $dbMs = round((hrtime(true) - $t) / 1e6, 1);

            return response()->json([
                'success' => true,
                'results' => $payload['results'],
                'query' => $query,
                'mode' => 'semantic',
                'count' => $payload['count'],
            ])->header('Server-Timing', $this->serverTimingHeader(['embed_ms' => $embedMs, 'db_ms' => $dbMs]));

        } catch (\Exception $e) {
            Log::error('Semantic search failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Search failed',
                'error' => config('app.debug') ? $e->getMessage() : null
            ], 500);
        }
    }

    /**
     * Execute node search with specified text search configuration.
     *
     * SQL assembly lives in SearchService::buildNodeSearchQuery (shared with
     * `php artisan search:profile`); the config whitelist (🔒 SQL-injection
     * guard) is enforced centrally by SearchService::nodeTsExpression.
     */
    private function executeNodeSearch(Request $request, string $tsQuery, string $config, int $limit)
    {
        [$sql, $params] = $this->searchService->buildNodeSearchQuery(
            $tsQuery,
            $config,
            $limit,
            Auth::user()?->name,
            $request->cookie('anon_token'),
        );

        // Read-only search on the search connection (BYPASSRLS in prod); the
        // visibility clause inside the query enforces access, not RLS.
        return collect(DB::connection(config('database.search_read_connection'))->select($sql, $params));
    }

    /**
     * Apply visibility filter.
     *
     * - $sourceScope = null (default) → legacy "public listed + caller's own books" union,
     *   used by /api/search/library and /api/search/nodes.
     * - $sourceScope = 'public' → only listed public books (no implicit own-books union).
     * - $sourceScope = 'mine' → only caller's own non-deleted books.
     * - $sourceScope = 'shelf' + $shelfId → only public books in the shelf.
     *
     * Private books are NEVER returned, regardless of scope.
     */
    private function applyVisibilityFilter($query, Request $request, string $tableAlias = null, ?string $sourceScope = null, ?string $shelfId = null): void
    {
        $prefix = $tableAlias ? "{$tableAlias}." : '';

        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        // Scope-aware path (citation modal, future scoped endpoints).
        if ($sourceScope !== null) {
            if ($sourceScope === 'shelf' && $shelfId) {
                $query->join('shelf_items', 'shelf_items.book', '=', "{$prefix}book")
                    ->where('shelf_items.shelf_id', $shelfId)
                    ->where("{$prefix}visibility", 'public');
                return;
            }

            if ($sourceScope === 'mine') {
                if ($user) {
                    $query->where("{$prefix}creator", $user->name)
                        ->where("{$prefix}visibility", '!=', 'deleted');
                } elseif ($anonymousToken) {
                    $query->where("{$prefix}creator_token", $anonymousToken)
                        ->where("{$prefix}visibility", '!=', 'deleted');
                } else {
                    $query->whereRaw('1 = 0'); // no identity, no own books
                }
                return;
            }

            // public (and any other value treated as public)
            $query->where("{$prefix}listed", true)
                ->whereNotIn("{$prefix}visibility", ['private', 'deleted']);
            return;
        }

        // Legacy path (public listed + caller's own books, unioned).
        $query->where(function ($q) use ($prefix, $user, $anonymousToken) {
            $q->where(function ($publicQuery) use ($prefix) {
                $publicQuery->where("{$prefix}listed", true)
                    ->whereNotIn("{$prefix}visibility", ['private', 'deleted']);
            });

            if ($user) {
                $q->orWhere(function ($userQuery) use ($prefix, $user) {
                    $userQuery->where("{$prefix}creator", $user->name)
                        ->where("{$prefix}visibility", '!=', 'deleted');
                });
            }

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

    /**
     * Format stage timings (keys like 'local_ms') as a Server-Timing header value,
     * visible in the browser devtools network waterfall — permanent, zero-UI
     * observability for "where did this search spend its time".
     */
    private function serverTimingHeader(array $timings): string
    {
        if (empty($timings)) {
            return 'app;dur=0';
        }
        return implode(', ', array_map(
            fn ($key, $value) => sprintf('%s;dur=%.1f', str_replace('_ms', '', $key), $value),
            array_keys($timings),
            array_values($timings),
        ));
    }
}
