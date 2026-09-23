<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class EmbeddingService
{
    /**
     * HTTP timeout for a BACKGROUND embedding call (queue jobs, reconcile,
     * indexing) — generous, because nothing is waiting on it.
     */
    public const TIMEOUT_BACKGROUND = 60;

    /**
     * HTTP timeout for an INTERACTIVE embedding call — one made inside a request
     * a user is waiting on (AI brain / archivist SSE, homepage semantic search).
     *
     * This MUST stay comfortably below the web server's FastCGI/proxy read
     * timeout, which is 60s by default in nginx and is NOT overridden by Herd
     * (dev) — see deploy/. A hung provider socket that runs the full background
     * 60s is therefore indistinguishable from a dead app: nginx tears down the
     * connection first, the SSE stream dies mid-flight, and the browser reports
     * a transport error ("network connection was lost" / TypeError: Load failed)
     * with NO error event ever rendered, because the request never got to return
     * one. That is exactly how a Fireworks /embeddings flap took the archivist
     * down on 2026-09-23 — the ask died 68s in with no terminal log line at all.
     *
     * Degrading to keyword-only search in 10s is strictly better than losing the
     * whole answer at 60s.
     */
    public const TIMEOUT_INTERACTIVE = 10;

    private string $baseUrl;
    private string $apiKey;
    private string $model;

    /**
     * Read connection for similarity queries. Same seam as SearchService:
     * under RLS the planner refuses the HNSW ordered scan (pgvector's
     * distance operators are not LEAKPROOF, the same trap that made GIN
     * unusable for FTS), so every query seq-scanned all embedded nodes —
     * pg_stat showed 0 scans on idx_nodes_embedding, ever. Visibility is
     * enforced by the explicit scope clauses in each query below, NOT by
     * RLS; that contract is locked by tests/Feature/AiBrain/RetrievalScopeTest.php.
     */
    private function searchConnection(): \Illuminate\Database\ConnectionInterface
    {
        return DB::connection(config('database.search_read_connection'));
    }

    public function __construct()
    {
        $this->baseUrl = rtrim(config('services.llm.base_url', ''), '/');
        $this->apiKey  = config('services.llm.api_key', '');
        $this->model   = config('services.llm.embedding_model', 'nomic-ai/nomic-embed-text-v1.5');
    }

    /**
     * Embed a single text string.
     * @param string $text The text to embed
     * @param string $prefix 'search_document: ' for indexing, 'search_query: ' for queries
     * @param int $maxRetries Interactive callers (homepage search, AI brain) pass 1
     *                        to fail fast instead of hanging ~6s behind the 2s/4s backoff
     * @param int $timeout    Per-attempt HTTP timeout. Interactive callers MUST pass
     *                        self::TIMEOUT_INTERACTIVE — the background default alone
     *                        exceeds nginx's 60s read timeout and kills the response.
     * @return array|null The embedding vector, or null on failure
     */
    public function embed(string $text, string $prefix = 'search_document: ', int $maxRetries = 3, int $timeout = self::TIMEOUT_BACKGROUND): ?array
    {
        $result = $this->embedBatch([$prefix . $text], $maxRetries, $timeout);
        return $result[0] ?? null;
    }

    /**
     * Embed a user search query for the semantic search endpoints (homepage +
     * journal/shelf), with the shared 1h vector cache. Query vectors are
     * user- and scope-independent, so the cache is global. Only successes are
     * cached — a null (provider outage) cached for an hour would pin the
     * caller's 503 long after recovery. Fails fast (maxRetries 1): these are
     * interactive paths where a 503 beats a ~6s backoff hang.
     *
     * @param string $normQuery already-normalized (trimmed, lowercased) query
     */
    public function embedSearchQuery(string $normQuery): ?array
    {
        $cacheKey = 'search:semantic:vec:' . md5($normQuery);
        $cached = \Illuminate\Support\Facades\Cache::get($cacheKey);
        if ($cached !== null) {
            return $cached;
        }
        $vector = $this->embed($normQuery, 'search_query: ', 1, self::TIMEOUT_INTERACTIVE);
        if ($vector !== null) {
            \Illuminate\Support\Facades\Cache::put($cacheKey, $vector, 3600);
        }
        return $vector;
    }

    /**
     * Run several embedding BATCH requests CONCURRENTLY (Http::pool — the
     * provider does the parallel work, PHP just holds the sockets). Each
     * batch is one request; texts must already carry their prefix.
     *
     * Built for PassageSearcher's two-pass flow: all needy-source document
     * chunks plus all query texts fly in one pooled round instead of
     * serially. No retries — callers there treat a failed batch as "no
     * semantic for those items" and the queue backfill self-heals later.
     *
     * @param array<string, string[]> $batches key => texts
     * @return array<string, array<int, array|null>> key => vectors (null per failed text)
     */
    public function poolEmbedBatches(array $batches): array
    {
        $out = [];
        if (empty($batches)) {
            return $out;
        }
        if (!$this->apiKey || !$this->baseUrl) {
            foreach ($batches as $key => $texts) {
                $out[$key] = array_fill(0, count($texts), null);
            }
            return $out;
        }

        $responses = Http::pool(function ($pool) use ($batches) {
            $requests = [];
            foreach ($batches as $key => $texts) {
                $requests[] = $pool->as((string) $key)
                    ->withHeaders(['Authorization' => 'Bearer ' . $this->apiKey])
                    ->timeout(60)
                    ->post($this->baseUrl . '/embeddings', [
                        'model' => $this->model,
                        'input' => array_values($texts),
                    ]);
            }
            return $requests;
        });

        foreach ($batches as $key => $texts) {
            $vectors = array_fill(0, count($texts), null);
            $response = $responses[(string) $key] ?? null;
            // A connection failure arrives as a Throwable in the pool array,
            // not a Response — treat anything non-successful as all-null.
            if ($response instanceof \Illuminate\Http\Client\Response && $response->successful()) {
                foreach ($response->json('data', []) as $item) {
                    $idx = $item['index'] ?? null;
                    if ($idx !== null && isset($item['embedding'])) {
                        $vectors[$idx] = $item['embedding'];
                    }
                }
            } else {
                Log::warning('poolEmbedBatches: batch failed', [
                    'key' => $key,
                    'status' => $response instanceof \Illuminate\Http\Client\Response ? $response->status() : get_debug_type($response),
                ]);
            }
            $out[$key] = $vectors;
        }
        return $out;
    }

    /**
     * Embed multiple texts in a single API call.
     * Texts should already include their prefix.
     * @return array Array of embedding vectors (null entries for failures)
     */
    public function embedBatch(array $texts, int $maxRetries = 3, int $timeout = self::TIMEOUT_BACKGROUND): array
    {
        if (empty($texts) || !$this->apiKey || !$this->baseUrl) {
            return array_fill(0, count($texts), null);
        }

        for ($attempt = 1; $attempt <= $maxRetries; $attempt++) {
            try {
                $response = Http::withHeaders([
                    'Authorization' => 'Bearer ' . $this->apiKey,
                ])->timeout($timeout)->post($this->baseUrl . '/embeddings', [
                    'model' => $this->model,
                    'input' => array_values($texts),
                ]);

                if ($response->successful()) {
                    $data = $response->json('data', []);
                    $results = array_fill(0, count($texts), null);

                    foreach ($data as $item) {
                        $idx = $item['index'] ?? null;
                        if ($idx !== null && isset($item['embedding'])) {
                            $results[$idx] = $item['embedding'];
                        }
                    }

                    return $results;
                }

                Log::warning("Embedding API returned {$response->status()} (attempt {$attempt}/{$maxRetries})", [
                    'body' => $response->body(),
                ]);
            } catch (\Exception $e) {
                Log::warning("Embedding API request failed (attempt {$attempt}/{$maxRetries}): " . $e->getMessage());
            }

            if ($attempt < $maxRetries) {
                sleep($attempt * 2); // 2s, 4s backoff
            }
        }

        return array_fill(0, count($texts), null);
    }

    /**
     * Search for similar nodes using cosine similarity.
     * JOINs library for citation metadata. Only searches public books.
     *
     * @param array $queryEmbedding The query vector
     * @param int $limit Max results
     * @param string|null $excludeBook Book ID to exclude from results
     * @return array Array of matching rows with similarity score
     */
    /**
     * 🔒 Privacy contract: NO private book is ever returned, regardless of scope.
     * Locked by tests/Feature/AiBrain/RetrievalScopeTest.php:
     *   - "searchSimilar: public scope excludes private books"
     *   - "searchSimilar: mine scope excludes the callers own private books"
     *   - "searchSimilar: shelf scope restricts to public shelf members only"
     *   - "searchSimilar: shelf scope with empty shelf returns nothing"
     * If you change a scope branch below, run that suite.
     */
    public function searchSimilar(array $queryEmbedding, int $limit = 10, ?string $excludeBook = null, string $sourceScope = 'public', ?string $creatorName = null, ?string $shelfId = null): array
    {
        $vectorStr = '[' . implode(',', $queryEmbedding) . ']';

        $query = $this->searchConnection()->table('nodes AS n')
            ->join('library AS l', 'n.book', '=', 'l.book')
            ->selectRaw('
                n.id,
                n.book,
                n."node_id",
                n."plainText",
                n.content,
                l.title AS book_title,
                l.author AS book_author,
                l.year AS book_year,
                l.bibtex,
                (n.embedding <=> ?::halfvec) AS distance
            ', [$vectorStr])
            ->whereNotNull('n.embedding')
            ->where('l.type', '!=', 'sub_book')
            ->orderByRaw('n.embedding <=> ?::halfvec', [$vectorStr])
            ->limit($limit);

        // Scope filtering — private books are NEVER returned, regardless of scope
        if ($sourceScope === 'shelf' && $shelfId) {
            $query->join('shelf_items AS si', 'si.book', '=', 'n.book')
                  ->where('si.shelf_id', $shelfId)
                  ->where('l.visibility', 'public');
        } elseif ($sourceScope === 'mine' && $creatorName) {
            $query->where('l.creator', $creatorName)
                  ->where('l.visibility', 'public');
        } else {
            // Default: public scope
            $query->where('l.visibility', 'public');
        }

        if ($excludeBook) {
            $query->where('n.book', '!=', $excludeBook);
        }

        return $query->get()->map(function ($row) {
            $row->similarity = 1 - $row->distance;
            return $row;
        })->toArray();
    }

    /**
     * Search for similar nodes by the same author using cosine similarity.
     * Identical to searchSimilar() but filtered to books by a specific author.
     */
    public function searchSimilarByAuthor(array $queryEmbedding, int $limit = 10, ?string $excludeBook = null, string $author = '', string $sourceScope = 'public', ?string $creatorName = null, ?string $shelfId = null): array
    {
        if (empty($author)) {
            return [];
        }

        $vectorStr = '[' . implode(',', $queryEmbedding) . ']';

        $query = $this->searchConnection()->table('nodes AS n')
            ->join('library AS l', 'n.book', '=', 'l.book')
            ->selectRaw('
                n.id,
                n.book,
                n."node_id",
                n."plainText",
                n.content,
                l.title AS book_title,
                l.author AS book_author,
                l.year AS book_year,
                l.bibtex,
                (n.embedding <=> ?::halfvec) AS distance
            ', [$vectorStr])
            ->whereNotNull('n.embedding')
            ->where('l.type', '!=', 'sub_book')
            ->where('l.author', $author)
            ->orderByRaw('n.embedding <=> ?::halfvec', [$vectorStr])
            ->limit($limit);

        // Scope filtering — private books are NEVER returned, regardless of scope
        if ($sourceScope === 'shelf' && $shelfId) {
            $query->join('shelf_items AS si', 'si.book', '=', 'n.book')
                  ->where('si.shelf_id', $shelfId)
                  ->where('l.visibility', 'public');
        } elseif ($sourceScope === 'mine' && $creatorName) {
            $query->where('l.creator', $creatorName)
                  ->where('l.visibility', 'public');
        } else {
            // Default: public scope
            $query->where('l.visibility', 'public');
        }

        if ($excludeBook) {
            $query->where('n.book', '!=', $excludeBook);
        }

        return $query->get()->map(function ($row) {
            $row->similarity = 1 - $row->distance;
            return $row;
        })->toArray();
    }

    /**
     * Get token usage estimate for billing.
     * Rough estimate: 1 token ≈ 4 chars.
     */
    public function estimateTokens(string $text): int
    {
        return (int) ceil(strlen($text) / 4);
    }
}
