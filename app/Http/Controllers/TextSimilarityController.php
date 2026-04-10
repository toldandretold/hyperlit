<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use App\Services\EmbeddingService;
use App\Services\LlmService;
use App\Services\BillingService;

class TextSimilarityController extends Controller
{
    private const MAX_RESULTS = 10;

    public function __construct(
        private EmbeddingService $embeddingService,
        private LlmService $llmService,
    ) {}

    // ------------------------------------------------------------------
    //  Main endpoint: POST /api/text-similarity/search
    // ------------------------------------------------------------------

    /**
     * Accept selected text (+ optional HTML), find similar content across the
     * hyperlit database, and return a ranked shortlist of node matches.
     *
     * Request body:
     *   text      – plain selected text (required)
     *   html      – HTML of the selection (optional, used to detect citations)
     *   book      – current book context (optional, used to scope citation lookups)
     *   limit     – max results (default 10)
     */
    public function search(Request $request): JsonResponse
    {
        $request->validate([
            'text' => 'required|string|min:3',
            'html' => 'nullable|string',
            'book' => 'nullable|string',
            'limit' => 'nullable|integer|min:1|max:50',
        ]);

        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Authentication required.'], 401);
        }

        if (!app(BillingService::class)->canProceed($user)) {
            return response()->json(['success' => false, 'message' => 'Insufficient balance.'], 402);
        }

        $text  = $request->input('text');
        $html  = $request->input('html', '');
        $book  = $request->input('book');
        $limit = min((int) $request->input('limit', self::MAX_RESULTS), 50);

        try {
            // -------------------------------------------------------
            // Step 1: Parse citations / footnotes / hypercites
            // -------------------------------------------------------
            $citations = $this->extractCitations($html ?: $text);

            $citationResults = [];
            if (!empty($citations)) {
                $citationResults = $this->searchByCitations($citations, $text, $book, $limit);
            }

            // -------------------------------------------------------
            // Step 2: Vector embedding similarity (all nodes)
            // -------------------------------------------------------
            $embeddingResults = $this->searchByEmbedding($text, $book, $limit);

            // -------------------------------------------------------
            // Step 3: Full-text keyword search (all nodes)
            // -------------------------------------------------------
            $keywordResults = $this->searchByKeywords($text, $request, $limit);

            // -------------------------------------------------------
            // Step 4: Merge, deduplicate, rank
            // -------------------------------------------------------
            $merged = $this->mergeAndRank($citationResults, $embeddingResults, $keywordResults, $limit);

            // -------------------------------------------------------
            // Step 5: LLM categorisation of top matches
            // -------------------------------------------------------
            $categorised = $this->categoriseMatches($text, $merged);

            return response()->json([
                'success'   => true,
                'query_text' => mb_substr($text, 0, 200),
                'citations_found' => $citations,
                'matches'   => $categorised,
                'count'     => count($categorised),
            ]);
        } catch (\Exception $e) {
            Log::error('Text similarity search failed: ' . $e->getMessage(), [
                'trace' => $e->getTraceAsString(),
            ]);
            return response()->json([
                'success' => false,
                'message' => 'Similarity search failed.',
                'error'   => config('app.debug') ? $e->getMessage() : null,
            ], 500);
        }
    }

    // ==================================================================
    //  Citation / Footnote / Hypercite detection
    // ==================================================================

    /**
     * Extract citation references from the selected HTML.
     * Returns array of ['type' => footnote|citation|hypercite, 'id' => '...', ...]
     */
    private function extractCitations(string $html): array
    {
        $found = [];

        // Footnotes: <sup ... id="Fn{timestamp}_{rand}" class="footnote-ref">
        if (preg_match_all('/id="(Fn\d{13}_[a-z0-9]{4})"/i', $html, $m)) {
            foreach ($m[1] as $id) {
                $found[] = ['type' => 'footnote', 'id' => $id];
            }
        }

        // Citations: <a id="Ref{timestamp}_{rand}" class="citation-ref">
        if (preg_match_all('/id="(Ref\d{13}_[a-z0-9]{4})"/i', $html, $m)) {
            foreach ($m[1] as $id) {
                $found[] = ['type' => 'citation', 'id' => $id];
            }
        }

        // Hypercites: <a href=".../{book}#{hyperciteId}" id="{hyperciteId}">
        if (preg_match_all('/href="[^"]*\/([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)"/i', $html, $m, PREG_SET_ORDER)) {
            foreach ($m as $match) {
                $found[] = [
                    'type'    => 'hypercite',
                    'id'      => $match[2],
                    'book'    => $match[1],
                ];
            }
        }

        return $found;
    }

    // ==================================================================
    //  Strategy 1: Search within cited source
    // ==================================================================

    /**
     * For each detected citation, find the source book/nodes and search
     * within them using text similarity + keywords + vector embeddings.
     */
    private function searchByCitations(array $citations, string $queryText, ?string $currentBook, int $limit): array
    {
        $results = [];

        foreach ($citations as $cite) {
            $sourceBook = null;

            if ($cite['type'] === 'footnote') {
                // Look up the footnote to find its book (footnotes table)
                $footnote = DB::table('footnotes')
                    ->where('footnoteId', $cite['id'])
                    ->when($currentBook, fn($q) => $q->where('book', $currentBook))
                    ->first();

                if ($footnote) {
                    // The footnote content may reference a bibliography entry
                    // Search within the same book's nodes
                    $sourceBook = $footnote->book;
                }
            } elseif ($cite['type'] === 'citation') {
                // Citation refs are stored in the nodes.footnotes JSON array
                // The referenceId links to a bibliography entry
                if ($currentBook) {
                    $bibEntry = DB::table('bibliography')
                        ->where('book', $currentBook)
                        ->whereRaw("raw_json::text LIKE ?", ['%' . $cite['id'] . '%'])
                        ->first();

                    if ($bibEntry && !empty($bibEntry->source_id)) {
                        // source_id links to a library.book entry
                        $sourceBook = $bibEntry->source_id;
                    }
                }
            } elseif ($cite['type'] === 'hypercite') {
                // Hypercite directly names the cited book
                $sourceBook = $cite['book'] ?? null;
            }

            if (!$sourceBook) {
                continue;
            }

            // Search within the cited source's nodes
            $sourceNodes = $this->searchWithinBook($sourceBook, $queryText, $limit);
            foreach ($sourceNodes as &$node) {
                $node['match_source'] = 'citation';
                $node['citation_type'] = $cite['type'];
                $node['citation_id'] = $cite['id'];
            }
            $results = array_merge($results, $sourceNodes);
        }

        return $results;
    }

    /**
     * Search within a specific book using vector + keyword search.
     */
    private function searchWithinBook(string $bookId, string $queryText, int $limit): array
    {
        $results = [];

        // Vector search within this book
        $embedding = $this->embeddingService->embed($queryText);
        if ($embedding) {
            $pgVector = $this->embeddingService->toPgVector($embedding);
            $vectorMatches = DB::select("
                SELECT node_id, book, \"startLine\",
                       LEFT(COALESCE(\"plainText\", content, ''), 300) as snippet,
                       1 - (embedding <=> ?::vector) as similarity
                FROM nodes
                WHERE book = ?
                  AND embedding IS NOT NULL
                ORDER BY embedding <=> ?::vector
                LIMIT ?
            ", [$pgVector, $bookId, $pgVector, $limit]);

            foreach ($vectorMatches as $row) {
                $results[] = [
                    'node_id'    => $row->node_id,
                    'book'       => $row->book,
                    'startLine'  => $row->startLine,
                    'snippet'    => $row->snippet,
                    'similarity' => round((float) $row->similarity, 4),
                    'method'     => 'vector_within_source',
                ];
            }
        }

        // Keyword search within this book
        $tsQuery = $this->buildTsQuery($queryText);
        if ($tsQuery) {
            $keywordMatches = DB::select("
                SELECT node_id, book, \"startLine\",
                       ts_headline('simple', COALESCE(\"plainText\", content, ''),
                           to_tsquery('simple', ?),
                           'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
                       ) as snippet,
                       ts_rank(search_vector_simple, to_tsquery('simple', ?)) as relevance
                FROM nodes
                WHERE book = ?
                  AND search_vector_simple @@ to_tsquery('simple', ?)
                ORDER BY relevance DESC
                LIMIT ?
            ", [$tsQuery, $tsQuery, $bookId, $tsQuery, $limit]);

            foreach ($keywordMatches as $row) {
                $results[] = [
                    'node_id'    => $row->node_id,
                    'book'       => $row->book,
                    'startLine'  => $row->startLine,
                    'snippet'    => $row->snippet,
                    'similarity' => round((float) $row->relevance, 4),
                    'method'     => 'keyword_within_source',
                ];
            }
        }

        return $results;
    }

    // ==================================================================
    //  Strategy 2: Global vector embedding search
    // ==================================================================

    private function searchByEmbedding(string $queryText, ?string $currentBook, int $limit): array
    {
        $embedding = $this->embeddingService->embed($queryText);
        if (!$embedding) {
            return [];
        }

        $pgVector = $this->embeddingService->toPgVector($embedding);

        // Exclude virtual/aggregate books and optionally the source book
        $excludeBooks = ['most-recent', 'most-connected', 'most-lit'];

        $rows = DB::select("
            SELECT n.node_id, n.book, n.\"startLine\",
                   LEFT(COALESCE(n.\"plainText\", n.content, ''), 300) as snippet,
                   1 - (n.embedding <=> ?::vector) as similarity,
                   l.title as book_title,
                   l.author as book_author
            FROM nodes n
            JOIN library l ON n.book = l.book
            WHERE n.embedding IS NOT NULL
              AND n.book NOT IN ('most-recent', 'most-connected', 'most-lit')
              AND (l.listed = true AND l.visibility NOT IN ('private', 'deleted'))
            ORDER BY n.embedding <=> ?::vector
            LIMIT ?
        ", [$pgVector, $pgVector, $limit]);

        $results = [];
        foreach ($rows as $row) {
            $results[] = [
                'node_id'     => $row->node_id,
                'book'        => $row->book,
                'startLine'   => $row->startLine,
                'snippet'     => $row->snippet,
                'similarity'  => round((float) $row->similarity, 4),
                'book_title'  => $row->book_title,
                'book_author' => $row->book_author,
                'method'      => 'vector_global',
                'match_source' => 'embedding',
            ];
        }

        return $results;
    }

    // ==================================================================
    //  Strategy 3: Full-text keyword search
    // ==================================================================

    private function searchByKeywords(string $queryText, Request $request, int $limit): array
    {
        $tsQuery = $this->buildTsQuery($queryText);
        if (!$tsQuery) {
            return [];
        }

        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        $visibilityConditions = ["(l.listed = true AND l.visibility NOT IN ('private', 'deleted'))"];
        $visibilityParams = [];

        if ($user) {
            $visibilityConditions[] = "(l.creator = ? AND l.visibility != 'deleted')";
            $visibilityParams[] = $user->name;
        }
        if ($anonymousToken) {
            $visibilityConditions[] = "(l.creator_token = ? AND l.visibility != 'deleted')";
            $visibilityParams[] = $anonymousToken;
        }

        $visibilityClause = '(' . implode(' OR ', $visibilityConditions) . ')';

        $sql = "
            SELECT sub.node_id, sub.book, sub.\"startLine\",
                   ts_headline('simple', sub.text_content,
                       to_tsquery('simple', ?),
                       'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
                   ) as snippet,
                   sub.relevance,
                   sub.title as book_title,
                   sub.author as book_author
            FROM (
                SELECT n.node_id, n.book, n.\"startLine\",
                       COALESCE(n.\"plainText\", n.content, '') as text_content,
                       ts_rank(n.search_vector_simple, to_tsquery('simple', ?)) as relevance,
                       l.title, l.author
                FROM nodes n
                JOIN library l ON n.book = l.book
                WHERE n.search_vector_simple @@ to_tsquery('simple', ?)
                  AND n.book NOT IN ('most-recent', 'most-connected', 'most-lit')
                  AND {$visibilityClause}
                ORDER BY relevance DESC
                LIMIT ?
            ) sub
        ";

        $params = array_merge(
            [$tsQuery, $tsQuery, $tsQuery],
            $visibilityParams,
            [$limit]
        );

        $rows = DB::select($sql, $params);

        $results = [];
        foreach ($rows as $row) {
            $results[] = [
                'node_id'     => $row->node_id,
                'book'        => $row->book,
                'startLine'   => $row->startLine,
                'snippet'     => $row->snippet,
                'similarity'  => round((float) $row->relevance, 4),
                'book_title'  => $row->book_title,
                'book_author' => $row->book_author,
                'method'      => 'keyword_global',
                'match_source' => 'keyword',
            ];
        }

        return $results;
    }

    // ==================================================================
    //  Merge & rank
    // ==================================================================

    /**
     * Combine results from all strategies, deduplicate by node_id,
     * and produce a final ranked list.
     */
    private function mergeAndRank(array $citationResults, array $embeddingResults, array $keywordResults, int $limit): array
    {
        $all = array_merge($citationResults, $embeddingResults, $keywordResults);

        // Deduplicate: keep highest-scoring entry per node_id
        $byNode = [];
        foreach ($all as $item) {
            $key = $item['node_id'];
            if (!isset($byNode[$key])) {
                $item['methods'] = [$item['method']];
                $byNode[$key] = $item;
            } else {
                // Add method to list and keep higher similarity
                $byNode[$key]['methods'][] = $item['method'];
                $byNode[$key]['methods'] = array_unique($byNode[$key]['methods']);

                // Boost score when found by multiple methods
                if ($item['similarity'] > $byNode[$key]['similarity']) {
                    $byNode[$key]['similarity'] = $item['similarity'];
                    $byNode[$key]['snippet'] = $item['snippet'];
                }

                // Prefer citation match_source
                if (($item['match_source'] ?? '') === 'citation') {
                    $byNode[$key]['match_source'] = 'citation';
                    $byNode[$key]['citation_type'] = $item['citation_type'] ?? null;
                    $byNode[$key]['citation_id'] = $item['citation_id'] ?? null;
                }
            }
        }

        // Score boost for multi-method matches
        foreach ($byNode as &$item) {
            $methodCount = count($item['methods']);
            if ($methodCount > 1) {
                $item['combined_score'] = $item['similarity'] * (1 + 0.1 * ($methodCount - 1));
            } else {
                $item['combined_score'] = $item['similarity'];
            }
        }
        unset($item);

        // Sort by combined score descending
        usort($byNode, fn($a, $b) => $b['combined_score'] <=> $a['combined_score']);

        return array_slice(array_values($byNode), 0, $limit);
    }

    // ==================================================================
    //  LLM categorisation
    // ==================================================================

    /**
     * Use DeepSeek to categorise each match: similarity, differences,
     * relationship type. Returns enriched match data.
     */
    private function categoriseMatches(string $queryText, array $matches): array
    {
        if (empty($matches)) {
            return [];
        }

        // Build batch LLM requests for top matches
        $requests = [];
        foreach ($matches as $i => $match) {
            $snippet = $match['snippet'] ?? '';
            if (empty($snippet)) {
                continue;
            }

            $requests[$i] = [
                'system' => <<<'PROMPT'
You are a scholarly text analyst. Given two text passages, categorise their relationship.
Return ONLY valid JSON with these fields:
{
  "relationship": "one of: direct_quote|paraphrase|thematic_overlap|contrasting_argument|shared_source|tangential|unrelated",
  "similarity_summary": "1 sentence describing what they share",
  "difference_summary": "1 sentence describing how they differ",
  "confidence": 0.0 to 1.0
}
Keep reasoning minimal. Budget tokens for the JSON.
PROMPT,
                'user' => "SELECTED TEXT:\n" . mb_substr($queryText, 0, 500) . "\n\nMATCHED TEXT:\n" . mb_substr(strip_tags($snippet), 0, 500),
                'model' => config('services.llm.verification_model'),
                'max_tokens' => 200,
                'temperature' => 0.0,
                'reasoning_effort' => 'none',
            ];
        }

        if (empty($requests)) {
            return $matches;
        }

        $responses = $this->llmService->chatBatch($requests, 30);

        foreach ($responses as $i => $raw) {
            if (!$raw) {
                $matches[$i]['categorisation'] = null;
                continue;
            }

            $raw = trim($raw);
            $raw = preg_replace('/^```(?:json)?\s*/i', '', $raw);
            $raw = preg_replace('/\s*```$/', '', $raw);
            // Strip think tags from reasoning models
            $raw = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $raw);
            $raw = trim($raw);

            $parsed = json_decode($raw, true);
            if (is_array($parsed) && isset($parsed['relationship'])) {
                $matches[$i]['categorisation'] = [
                    'relationship'       => $parsed['relationship'],
                    'similarity_summary' => $parsed['similarity_summary'] ?? null,
                    'difference_summary' => $parsed['difference_summary'] ?? null,
                    'confidence'         => round((float) ($parsed['confidence'] ?? 0), 2),
                ];
            } else {
                $matches[$i]['categorisation'] = null;
            }
        }

        return $matches;
    }

    // ==================================================================
    //  Utilities
    // ==================================================================

    /**
     * Build a PostgreSQL tsquery from freeform text.
     * Extracts significant words (skipping very short ones), joins with &.
     */
    private function buildTsQuery(string $text): string
    {
        // Take first ~200 chars to keep queries reasonable
        $text = mb_substr(trim($text), 0, 200);
        if (empty($text)) {
            return '';
        }

        // Extract words, skip very short ones
        $words = preg_split('/\s+/', $text);
        $words = array_filter($words, fn($w) => mb_strlen(preg_replace('/[^\w]/', '', $w)) >= 3);
        $words = array_slice(array_values($words), 0, 8); // Max 8 terms

        if (empty($words)) {
            return '';
        }

        $clean = [];
        foreach ($words as $word) {
            $word = preg_replace('/[^\w\-]/', '', $word);
            if (!empty($word)) {
                $clean[] = $word;
            }
        }

        return implode(' & ', $clean);
    }
}
