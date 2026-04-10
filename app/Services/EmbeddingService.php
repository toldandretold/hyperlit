<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class EmbeddingService
{
    private string $baseUrl;
    private string $apiKey;
    private string $model;

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
     * @return array|null The embedding vector, or null on failure
     */
    public function embed(string $text, string $prefix = 'search_document: '): ?array
    {
        $result = $this->embedBatch([$prefix . $text]);
        return $result[0] ?? null;
    }

    /**
     * Embed multiple texts in a single API call.
     * Texts should already include their prefix.
     * @return array Array of embedding vectors (null entries for failures)
     */
    public function embedBatch(array $texts): array
    {
        if (empty($texts) || !$this->apiKey || !$this->baseUrl) {
            return array_fill(0, count($texts), null);
        }

        try {
            $response = Http::withHeaders([
                'Authorization' => 'Bearer ' . $this->apiKey,
            ])->timeout(60)->post($this->baseUrl . '/embeddings', [
                'model' => $this->model,
                'input' => array_values($texts),
            ]);

            if (!$response->successful()) {
                Log::warning('Embedding API returned ' . $response->status(), [
                    'body' => $response->body(),
                ]);
                return array_fill(0, count($texts), null);
            }

            $data = $response->json('data', []);
            $results = array_fill(0, count($texts), null);

            foreach ($data as $item) {
                $idx = $item['index'] ?? null;
                if ($idx !== null && isset($item['embedding'])) {
                    $results[$idx] = $item['embedding'];
                }
            }

            return $results;
        } catch (\Exception $e) {
            Log::warning('Embedding API request failed: ' . $e->getMessage());
            return array_fill(0, count($texts), null);
        }
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
    public function searchSimilar(array $queryEmbedding, int $limit = 10, ?string $excludeBook = null): array
    {
        $vectorStr = '[' . implode(',', $queryEmbedding) . ']';

        $query = DB::table('nodes AS n')
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
                (n.embedding <=> ?::vector) AS distance
            ', [$vectorStr])
            ->whereNotNull('n.embedding')
            ->where('l.visibility', 'public')
            ->where('l.type', '!=', 'sub_book')
            ->orderByRaw('n.embedding <=> ?::vector', [$vectorStr])
            ->limit($limit);

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
    public function searchSimilarByAuthor(array $queryEmbedding, int $limit = 10, ?string $excludeBook = null, string $author = ''): array
    {
        if (empty($author)) {
            return [];
        }

        $vectorStr = '[' . implode(',', $queryEmbedding) . ']';

        $query = DB::table('nodes AS n')
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
                (n.embedding <=> ?::vector) AS distance
            ', [$vectorStr])
            ->whereNotNull('n.embedding')
            ->where('l.visibility', 'public')
            ->where('l.type', '!=', 'sub_book')
            ->where('l.author', $author)
            ->orderByRaw('n.embedding <=> ?::vector', [$vectorStr])
            ->limit($limit);

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
