<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class LlmService
{
    private string $baseUrl;
    private string $apiKey;
    private string $model;
    private string $verificationModel;

    public function __construct()
    {
        $this->baseUrl = rtrim(config('services.llm.base_url', ''), '/');
        $this->apiKey  = config('services.llm.api_key', '');
        $this->model   = config('services.llm.model', '');
        $this->verificationModel = config('services.llm.verification_model', '') ?: $this->model;
    }

    /**
     * Send a chat completion request (OpenAI-compatible format).
     */
    public function chat(string $systemPrompt, string $userMessage, float $temperature = 0.0, int $maxTokens = 200, ?string $model = null): ?string
    {
        if (!$this->apiKey || !$this->baseUrl) {
            return null;
        }

        try {
            $response = Http::withHeaders([
                'Authorization' => 'Bearer ' . $this->apiKey,
            ])->timeout(30)->post($this->baseUrl . '/chat/completions', [
                'model'            => $model ?? $this->model,
                'temperature'      => $temperature,
                'max_tokens'       => $maxTokens,
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

    /**
     * Extract truth claims from a paragraph with [CITE:refId] markers.
     * Returns array of {referenceId, truth_claim} or null on failure.
     */
    public function extractTruthClaims(string $markedText, array $citationContext): ?array
    {
        $systemPrompt = <<<'PROMPT'
You are an academic citation analyst. The text contains inline citations as [CITE:refId] markers.

For each citation, determine what part of the text it is supporting. A citation may support:
- Just the clause it appears in
- The full sentence
- Multiple preceding sentences
- An entire paragraph

Use the provided information about each cited source to help determine scope.

Return ONLY valid JSON: [{"referenceId": "refId", "truth_claim": "exact words from the text"}]

CRITICAL RULES:
- The truth_claim MUST be copied VERBATIM from the input text — do not change, rephrase, or summarize any words
- Do not include the citation marker [CITE:...] itself in the truth_claim
- Include the full scope of text the citation supports
PROMPT;

        $userMessage = "TEXT:\n{$markedText}\n\nCITATION SOURCES:\n";
        foreach ($citationContext as $refId => $meta) {
            $title = $meta['title'] ?? 'Unknown';
            $abstract = $meta['abstract'] ?? 'No abstract available';
            $userMessage .= "- [CITE:{$refId}]: \"{$title}\" — Abstract: {$abstract}\n";
        }

        $result = $this->chat($systemPrompt, $userMessage, 0.0, 800);

        if (!$result) {
            return null;
        }

        $result = trim($result);
        $result = preg_replace('/^```(?:json)?\s*/i', '', $result);
        $result = preg_replace('/\s*```$/', '', $result);

        $parsed = json_decode($result, true);
        if (!is_array($parsed)) {
            Log::warning('LLM truth claim extraction: invalid JSON response', ['raw' => $result]);
            return null;
        }

        return $parsed;
    }

    /**
     * Verify whether source material supports a truth claim.
     * Returns {matches: bool|null, summary, reasoning} or null on failure.
     */
    public function verifyCitation(string $truthClaim, string $sourceMaterial): ?array
    {
        $systemPrompt = <<<'PROMPT'
You are verifying an academic citation. Does the source material support the truth claim?

Please be accurate — I don't care about the outcome either way, I just want truth.

Return ONLY valid JSON:
{"matches": true/false/null, "summary": "One sentence on whether the meaning matches", "reasoning": "One sentence on why you think so"}

Set matches to null if the source material is insufficient to determine.
PROMPT;

        $userMessage = "TRUTH CLAIM: {$truthClaim}\n\nSOURCE MATERIAL:\n{$sourceMaterial}";

        $result = $this->chat($systemPrompt, $userMessage, 0.0, 300, $this->verificationModel);

        if (!$result) {
            return null;
        }

        $result = trim($result);
        $result = preg_replace('/^```(?:json)?\s*/i', '', $result);
        $result = preg_replace('/\s*```$/', '', $result);

        $parsed = json_decode($result, true);
        if (!is_array($parsed) || !array_key_exists('matches', $parsed)) {
            Log::warning('LLM citation verification: invalid JSON response', ['raw' => $result]);
            return null;
        }

        return $parsed;
    }
}
