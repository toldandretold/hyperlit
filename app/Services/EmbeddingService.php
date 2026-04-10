<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class EmbeddingService
{
    private string $baseUrl;
    private string $apiKey;
    private string $model;
    private int $dimensions;

    public function __construct()
    {
        $this->baseUrl    = rtrim(config('services.llm.base_url', ''), '/');
        $this->apiKey     = config('services.llm.api_key', '');
        $this->model      = config('services.llm.embedding_model', 'nomic-ai/nomic-embed-text-v1.5');
        $this->dimensions = (int) config('services.llm.embedding_dimensions', 768);
    }

    /**
     * Generate an embedding vector for a single text string.
     * Returns a float array of $dimensions length, or null on failure.
     */
    public function embed(string $text): ?array
    {
        $results = $this->embedBatch([$text]);
        return $results[0] ?? null;
    }

    /**
     * Generate embeddings for multiple texts in one API call.
     * Returns an array of float arrays (one per input), null entries on failure.
     *
     * Fireworks / OpenAI-compatible endpoint: POST /embeddings
     */
    public function embedBatch(array $texts, int $timeout = 30): array
    {
        if (!$this->apiKey || !$this->baseUrl || empty($texts)) {
            return array_fill(0, count($texts), null);
        }

        // Truncate very long texts to avoid token limits (roughly 8k tokens ≈ 32k chars)
        $maxChars = 30000;
        $prepared = array_map(fn(string $t) => mb_substr(trim($t), 0, $maxChars), $texts);

        try {
            $response = Http::withHeaders([
                'Authorization' => 'Bearer ' . $this->apiKey,
            ])->timeout($timeout)->post($this->baseUrl . '/embeddings', [
                'model' => $this->model,
                'input' => $prepared,
            ]);

            if (!$response->successful()) {
                Log::warning('Embedding API returned ' . $response->status(), [
                    'body' => $response->body(),
                ]);
                return array_fill(0, count($texts), null);
            }

            $data = $response->json('data');
            if (!is_array($data)) {
                return array_fill(0, count($texts), null);
            }

            // The API returns data sorted by index
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
     * Format an embedding array as a pgvector-compatible string: '[0.1,0.2,...]'
     */
    public function toPgVector(array $embedding): string
    {
        return '[' . implode(',', $embedding) . ']';
    }

    public function getDimensions(): int
    {
        return $this->dimensions;
    }
}
