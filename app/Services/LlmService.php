<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class LlmService
{
    private string $baseUrl;
    private string $apiKey;
    private string $model;

    public function __construct()
    {
        $this->baseUrl = rtrim(config('services.llm.base_url', ''), '/');
        $this->apiKey  = config('services.llm.api_key', '');
        $this->model   = config('services.llm.model', '');
    }

    /**
     * Send a chat completion request (OpenAI-compatible format).
     */
    public function chat(string $systemPrompt, string $userMessage, float $temperature = 0.0): ?string
    {
        if (!$this->apiKey || !$this->baseUrl) {
            return null;
        }

        try {
            $response = Http::withHeaders([
                'Authorization' => 'Bearer ' . $this->apiKey,
            ])->timeout(30)->post($this->baseUrl . '/chat/completions', [
                'model'            => $this->model,
                'temperature'      => $temperature,
                'max_tokens'       => 200,
                'reasoning_effort' => 'none',
                'messages'         => [
                    ['role' => 'system', 'content' => $systemPrompt],
                    ['role' => 'user',   'content' => $userMessage],
                ],
            ]);

            if (!$response->successful()) {
                Log::warning('LLM API returned ' . $response->status(), [
                    'body' => $response->body(),
                ]);
                return null;
            }

            return $response->json('choices.0.message.content');
        } catch (\Exception $e) {
            Log::warning('LLM API request failed: ' . $e->getMessage());
            return null;
        }
    }

    /**
     * Extract structured metadata from a citation using the LLM.
     * Returns associative array with: title, authors, year, journal, publisher — or null on failure.
     */
    public function extractCitationMetadata(string $citationHtml): ?array
    {
        $plain = strip_tags($citationHtml);
        $result = $this->chat(
            'Extract structured metadata from this bibliography entry. Return ONLY valid JSON with these fields: {"title": "...", "authors": ["Lastname, Firstname", ...], "year": 2000, "journal": "...", "publisher": "..."}. Use null for any field you cannot determine. The year must be an integer or null. Authors must be an array of strings in "Lastname, Firstname" format.',
            $plain
        );

        if (!$result) {
            return null;
        }

        // Strip markdown code fences if present
        $result = trim($result);
        $result = preg_replace('/^```(?:json)?\s*/i', '', $result);
        $result = preg_replace('/\s*```$/', '', $result);

        $parsed = json_decode($result, true);
        if (!is_array($parsed) || empty($parsed['title'])) {
            Log::warning('LLM metadata extraction: invalid JSON response', [
                'raw' => $result,
            ]);
            return null;
        }

        // Normalise fields
        return [
            'title'     => is_string($parsed['title']) ? trim($parsed['title']) : null,
            'authors'   => is_array($parsed['authors'] ?? null) ? $parsed['authors'] : [],
            'year'      => is_numeric($parsed['year'] ?? null) ? (int) $parsed['year'] : null,
            'journal'   => is_string($parsed['journal'] ?? null) ? trim($parsed['journal']) : null,
            'publisher' => is_string($parsed['publisher'] ?? null) ? trim($parsed['publisher']) : null,
        ];
    }

    /**
     * Extract the title of the cited work from a raw citation string using the LLM.
     */
    public function extractCitationTitle(string $citationHtml): ?string
    {
        $plain = strip_tags($citationHtml);
        $result = $this->chat(
            'Extract ONLY the title of the cited work from this bibliography entry. Return just the title text, nothing else. No quotes, no punctuation at the end.',
            $plain
        );

        return $result ? trim($result, " \t\n\r\"'") : null;
    }
}
