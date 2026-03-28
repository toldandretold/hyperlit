<?php

namespace App\Services;

use Illuminate\Http\Client\Pool;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

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
    public function chat(string $systemPrompt, string $userMessage, float $temperature = 0.0, int $maxTokens = 200, ?string $model = null, int $timeout = 30, ?string $reasoningEffort = 'none'): ?string
    {
        if (!$this->apiKey || !$this->baseUrl) {
            return null;
        }

        try {
            $body = [
                'model'       => $model ?? $this->model,
                'temperature' => $temperature,
                'max_tokens'  => $maxTokens,
                'messages'    => [
                    ['role' => 'system', 'content' => $systemPrompt],
                    ['role' => 'user',   'content' => $userMessage],
                ],
            ];
            if ($reasoningEffort !== null) {
                $body['reasoning_effort'] = $reasoningEffort;
            }

            $response = Http::withHeaders([
                'Authorization' => 'Bearer ' . $this->apiKey,
            ])->timeout($timeout)->post($this->baseUrl . '/chat/completions', $body);

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
     * Send multiple chat completion requests concurrently using HTTP pool.
     * Each request: [system, user, model?, temperature?, max_tokens?, reasoning_effort?]
     * Returns array keyed same as input with raw response strings (null for failures).
     */
    public function chatBatch(array $requests, int $timeout = 30): array
    {
        if (!$this->apiKey || !$this->baseUrl) {
            return array_fill_keys(array_keys($requests), null);
        }

        try {
            $url = $this->baseUrl . '/chat/completions';
            $apiKey = $this->apiKey;
            $defaultModel = $this->model;

            $responses = Http::pool(function (Pool $pool) use ($requests, $timeout, $url, $apiKey, $defaultModel) {
                foreach ($requests as $key => $req) {
                    $body = [
                        'model'       => $req['model'] ?? $defaultModel,
                        'temperature' => $req['temperature'] ?? 0.0,
                        'max_tokens'  => $req['max_tokens'] ?? 200,
                        'messages'    => [
                            ['role' => 'system', 'content' => $req['system']],
                            ['role' => 'user',   'content' => $req['user']],
                        ],
                    ];
                    if (array_key_exists('reasoning_effort', $req)) {
                        $body['reasoning_effort'] = $req['reasoning_effort'];
                    }

                    $pool->as((string) $key)
                        ->withHeaders(['Authorization' => 'Bearer ' . $apiKey])
                        ->timeout($timeout)
                        ->post($url, $body);
                }
            });

            $results = [];
            foreach ($requests as $key => $_) {
                $response = $responses[(string) $key] ?? null;
                if ($response && $response->successful()) {
                    $results[$key] = $response->json('choices.0.message.content');
                } else {
                    if ($response) {
                        Log::warning('LLM batch: request ' . $key . ' returned ' . $response->status());
                    }
                    $results[$key] = null;
                }
            }

            return $results;
        } catch (\Exception $e) {
            Log::warning('LLM batch request failed: ' . $e->getMessage());
            return array_fill_keys(array_keys($requests), null);
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
     * Extract structured metadata from multiple citations concurrently.
     * @param array $citations Array of citation HTML strings keyed by any key
     * @return array Parsed metadata keyed same as input (null for failures)
     */
    public function extractCitationMetadataBatch(array $citations): array
    {
        $systemPrompt = 'Extract structured metadata from this bibliography entry. Return ONLY valid JSON with these fields: {"title": "...", "authors": ["Lastname, Firstname", ...], "year": 2000, "journal": "...", "publisher": "..."}. Use null for any field you cannot determine. The year must be an integer or null. Authors must be an array of strings in "Lastname, Firstname" format.';

        $requests = [];
        foreach ($citations as $key => $html) {
            $requests[$key] = [
                'system'           => $systemPrompt,
                'user'             => strip_tags($html),
                'max_tokens'       => 200,
                'temperature'      => 0.0,
                'reasoning_effort' => 'none',
            ];
        }

        $batchSize = 30;
        $keys = array_keys($requests);
        $chunks = array_chunk($keys, $batchSize);
        $allResults = [];

        foreach ($chunks as $chunkIndex => $chunkKeys) {
            $batchRequests = [];
            foreach ($chunkKeys as $k) {
                $batchRequests[$k] = $requests[$k];
            }

            $rawResponses = $this->chatBatch($batchRequests, 30);

            foreach ($rawResponses as $k => $raw) {
                if (!$raw) {
                    $allResults[$k] = null;
                    continue;
                }

                $raw = trim($raw);
                $raw = preg_replace('/^```(?:json)?\s*/i', '', $raw);
                $raw = preg_replace('/\s*```$/', '', $raw);

                $parsed = json_decode($raw, true);
                if (!is_array($parsed) || empty($parsed['title'])) {
                    Log::warning('LLM batch metadata extraction: invalid JSON response', ['raw' => $raw]);
                    $allResults[$k] = null;
                    continue;
                }

                $allResults[$k] = [
                    'title'     => is_string($parsed['title']) ? trim($parsed['title']) : null,
                    'authors'   => is_array($parsed['authors'] ?? null) ? $parsed['authors'] : [],
                    'year'      => is_numeric($parsed['year'] ?? null) ? (int) $parsed['year'] : null,
                    'journal'   => is_string($parsed['journal'] ?? null) ? trim($parsed['journal']) : null,
                    'publisher' => is_string($parsed['publisher'] ?? null) ? trim($parsed['publisher']) : null,
                ];
            }

            if ($chunkIndex < count($chunks) - 1) {
                usleep(250_000);
            }
        }

        return $allResults;
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
     * System prompt for truth claim extraction.
     */
    private function extractClaimsSystemPrompt(): string
    {
        return <<<'PROMPT'
You are an academic citation analyst. The text contains inline citations as [CITE:refId] markers.

For each [CITE:refId], extract the sentence it appears in and identify what factual claim the citation supports.

Return ONLY valid JSON: [{"referenceId": "refId", "truth_claim": "...", "contextualised_claim": "..."}]

RULES:
- Each citation includes the sentence it appears in (after "— appears in sentence:"). Use this to correctly identify which sentence to extract. The truth_claim should be this sentence.
- If the sentence is an anaphoric reference (e.g. "The same argument is made by...", "This is also noted by..."), include the substantive preceding sentence(s) that contain the actual claim.
- truth_claim: Copy the COMPLETE SENTENCE containing [CITE:refId] VERBATIM from the TEXT section. Do not include the [CITE:...] marker itself. Do not rephrase, summarise, or truncate.
- If two citations appear in the same sentence, produce one entry per referenceId, both with the same truth_claim sentence.
- contextualised_claim: Rewrite the truth_claim so the FACTUAL SUBSTANCE is fully self-contained and verifiable in isolation.
  Do NOT include author names or attribution phrases ("X argues", "attributed to Y", "according to Z").
  State ONLY the factual assertion itself — the verification step already knows which source is being checked.
  Resolve ALL:
  • Pronouns ("this", "these", "it", "they")
  • Demonstratives ("the former approach", "such conditions")
  • Anaphoric references
  • Comparative/relational phrases ("a similar argument", "the same conclusion", "a comparable finding", "this approach", "likewise")

  For comparative claims: identify what specific argument/conclusion/finding is being referred to
  by reading the PRECEDING CONTEXT and TEXT sections. State that substance explicitly.
  Example: "X presents a similar argument" → find what argument is described in the preceding
  sentences and write "[substance from preceding text]".

  CRITICAL: Use ONLY information from the PRECEDING CONTEXT and TEXT to resolve references.
  Do NOT use your own knowledge to infer what the argument is.
  The contextualised_claim must reflect what the AUTHOR OF THE TEXT is attributing to the source,
  based on the surrounding sentences — not what you think the cited source actually says.

  If the truth_claim is already fully self-contained and verifiable, copy it as-is.

IMPORTANT: Keep your reasoning brief. Budget most of your output tokens for the JSON response, not thinking.
PROMPT;
    }

    /**
     * Build user message for truth claim extraction.
     */
    private function buildExtractClaimsMessage(string $markedText, array $citationContext, string $precedingContext = '', array $extractedSentences = []): string
    {
        $msg = '';
        if ($precedingContext !== '') {
            $msg .= "PRECEDING CONTEXT:\n{$precedingContext}\n\n";
        }
        $msg .= "TEXT:\n{$markedText}\n\nCITATION SOURCES:\n";
        foreach ($citationContext as $refId => $meta) {
            $title = $meta['title'] ?? 'Unknown';
            $line = "- [CITE:{$refId}]: \"{$title}\"";
            if (!empty($extractedSentences[$refId])) {
                $line .= " — appears in sentence: \"{$extractedSentences[$refId]}\"";
            }
            $msg .= $line . "\n";
        }
        return $msg;
    }

    /**
     * Parse raw LLM response for truth claim extraction.
     */
    private function parseExtractClaimsResult(?string $result): ?array
    {
        if (!$result) {
            return null;
        }

        $result = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $result);
        if (str_contains($result, '<think>')) {
            $result = preg_replace('/<think>[\s\S]*/i', '', $result);
        }

        $result = trim($result);
        $result = preg_replace('/^```(?:json)?\s*/i', '', $result);
        $result = preg_replace('/\s*```$/', '', $result);

        $parsed = json_decode($result, true);

        // LLM sometimes returns multiple JSON arrays instead of one: [{...}]\n[{...}]
        if (!is_array($parsed)) {
            $merged = [];
            foreach (preg_split('/\]\s*\[/', $result) as $fragment) {
                $fragment = '[' . ltrim($fragment, '[');
                $fragment = rtrim($fragment, ']') . ']';
                $sub = json_decode($fragment, true);
                if (is_array($sub)) {
                    array_push($merged, ...$sub);
                }
            }
            $parsed = !empty($merged) ? $merged : null;
        }

        if (!is_array($parsed)) {
            Log::warning('LLM truth claim extraction: invalid JSON response', ['raw' => $result]);
            return null;
        }

        return $parsed;
    }

    /**
     * Extract truth claims from a paragraph with [CITE:refId] markers.
     * Returns array of {referenceId, truth_claim} or null on failure.
     */
    public function extractTruthClaims(string $markedText, array $citationContext, string $precedingContext = '', array $extractedSentences = []): ?array
    {
        $result = $this->chat(
            $this->extractClaimsSystemPrompt(),
            $this->buildExtractClaimsMessage($markedText, $citationContext, $precedingContext, $extractedSentences),
            0.0, 4096, $this->verificationModel, 120, reasoningEffort: null
        );
        return $this->parseExtractClaimsResult($result);
    }

    /**
     * Extract truth claims for multiple nodes concurrently.
     * @param array $items Array of [markedText, citationContext, precedingContext, extractedSentences]
     * @return array Parsed results keyed same as input (null for failures)
     */
    public function extractTruthClaimsBatch(array $items): array
    {
        $requests = [];
        foreach ($items as $key => $item) {
            [$markedText, $citationContext, $precedingContext] = $item;
            $extractedSentences = $item[3] ?? [];
            $requests[$key] = [
                'system'      => $this->extractClaimsSystemPrompt(),
                'user'        => $this->buildExtractClaimsMessage($markedText, $citationContext, $precedingContext, $extractedSentences),
                'model'       => $this->verificationModel,
                'max_tokens'  => 4096,
                'temperature' => 0.0,
            ];
        }

        $rawResponses = $this->chatBatch($requests, 120);

        $results = [];
        foreach ($rawResponses as $key => $raw) {
            $results[$key] = $this->parseExtractClaimsResult($raw);
        }
        return $results;
    }

    /**
     * Assess whether HTML from a publisher page contains real article content.
     * Returns {has_article_content, content_selector, abstract, is_blocked} or null on failure.
     */
    public function assessHtmlContent(string $html): ?array
    {
        $systemPrompt = <<<'PROMPT'
Analyze this HTML from a publisher page. Return ONLY valid JSON:
{"has_article_content": bool, "content_selector": string|null, "abstract": string|null, "is_blocked": bool}

- has_article_content: true ONLY if there are multiple paragraphs of actual article/chapter body text — not just metadata, navigation, or a single abstract paragraph.
- content_selector: CSS-like description of the div(s) containing the article body (e.g. "div.article-body", "section[data-article-body]"). null if no article content.
- abstract: the abstract text if found in the body (not from meta tags). null if not found.
- is_blocked: true if this is a captcha page, login wall, cookie consent wall, or verification page with no real content.
PROMPT;

        $result = $this->chat($systemPrompt, $html, 0.0, 400);

        if (!$result) {
            return null;
        }

        $result = trim($result);
        $result = preg_replace('/^```(?:json)?\s*/i', '', $result);
        $result = preg_replace('/\s*```$/', '', $result);

        $parsed = json_decode($result, true);
        if (!is_array($parsed) || !array_key_exists('has_article_content', $parsed)) {
            Log::warning('LLM HTML assessment: invalid JSON response', ['raw' => $result]);
            return null;
        }

        return [
            'has_article_content' => (bool) ($parsed['has_article_content'] ?? false),
            'content_selector'    => is_string($parsed['content_selector'] ?? null) ? $parsed['content_selector'] : null,
            'abstract'            => is_string($parsed['abstract'] ?? null) ? trim($parsed['abstract']) : null,
            'is_blocked'          => (bool) ($parsed['is_blocked'] ?? false),
        ];
    }

    /**
     * Check whether a piece of text is a genuine abstract/description for the given title.
     * Returns true if it looks like a real abstract, false if it's junk (paywall, metadata, etc.).
     */
    public function validateAbstract(string $text, string $title): bool
    {
        if (strlen($text) < 30 || !$title) {
            return false;
        }

        $systemPrompt = <<<'PROMPT'
Does this text look like a real academic abstract or description for the given work?
Return ONLY valid JSON: {"is_abstract": true}
Return {"is_abstract": false} if it is: a paywall message, access instructions, citation metadata,
a database listing, HTML fragments, or otherwise not a genuine summary of the work's content.
PROMPT;

        $userMessage = "TITLE: {$title}\n\nTEXT:\n{$text}";
        $result = $this->chat($systemPrompt, $userMessage, 0.0, 50);

        if (!$result) {
            return false;
        }

        $result = trim($result);
        $result = preg_replace('/^```(?:json)?\s*/i', '', $result);
        $result = preg_replace('/\s*```$/', '', $result);

        $parsed = json_decode($result, true);

        return is_array($parsed) && !empty($parsed['is_abstract']);
    }

    /**
     * Validate multiple abstracts concurrently.
     * @param array $items Array of [text, title]
     * @return array Boolean results keyed same as input
     */
    public function validateAbstractBatch(array $items): array
    {
        $systemPrompt = <<<'PROMPT'
Does this text look like a real academic abstract or description for the given work?
Return ONLY valid JSON: {"is_abstract": true}
Return {"is_abstract": false} if it is: a paywall message, access instructions, citation metadata,
a database listing, HTML fragments, or otherwise not a genuine summary of the work's content.
PROMPT;

        $requests = [];
        $shortCircuit = [];

        foreach ($items as $key => [$text, $title]) {
            if (strlen($text) < 30 || !$title) {
                $shortCircuit[$key] = false;
            } else {
                $requests[$key] = [
                    'system'           => $systemPrompt,
                    'user'             => "TITLE: {$title}\n\nTEXT:\n{$text}",
                    'max_tokens'       => 50,
                    'temperature'      => 0.0,
                    'reasoning_effort' => 'none',
                ];
            }
        }

        $rawResponses = !empty($requests) ? $this->chatBatch($requests, 30) : [];

        $results = [];
        foreach ($items as $key => $_) {
            if (isset($shortCircuit[$key])) {
                $results[$key] = false;
                continue;
            }

            $raw = $rawResponses[$key] ?? null;
            if (!$raw) {
                $results[$key] = false;
                continue;
            }

            $raw = trim($raw);
            $raw = preg_replace('/^```(?:json)?\s*/i', '', $raw);
            $raw = preg_replace('/\s*```$/', '', $raw);
            $parsed = json_decode($raw, true);
            $results[$key] = is_array($parsed) && !empty($parsed['is_abstract']);
        }

        return $results;
    }

    /**
     * Screen fetched web content for relevance to a cited work's title.
     * Returns true if content is substantive and related, false for junk pages.
     */
    public function validateWebContent(string $text, string $title): bool
    {
        if (strlen($text) < 100 || !$title) {
            return false;
        }

        $systemPrompt = <<<'PROMPT'
Is this text actual content from a web page about the cited work?
Return ONLY valid JSON: {"relevant": true} if it contains substantive article, report, or institutional content related to the title.
Return {"relevant": false} if it is: a cookie/consent wall, 404 error page, login/paywall page, CAPTCHA challenge, navigation menu only, or content clearly unrelated to the title.
PROMPT;

        // Pass first ~1500 chars to keep token cost low
        $snippet = Str::limit($text, 1500, '...');
        $userMessage = "TITLE: {$title}\n\nTEXT:\n{$snippet}";
        $result = $this->chat($systemPrompt, $userMessage, 0.0, 50);

        if (!$result) {
            return false;
        }

        $result = trim($result);
        $result = preg_replace('/^```(?:json)?\s*/i', '', $result);
        $result = preg_replace('/\s*```$/', '', $result);

        $parsed = json_decode($result, true);

        return is_array($parsed) && !empty($parsed['relevant']);
    }

    /**
     * System prompt for citation verification.
     */
    private function verifyCitationSystemPrompt(): string
    {
        return <<<'PROMPT'
You are verifying an academic citation. Does the source material support the truth claim?

Be accurate — I want truth, not caution. Read the evidence carefully before judging.

IMPORTANT: "confirmed" includes logical entailment. If the source says "X and Y both experienced Z",
then a claim about X experiencing Z is CONFIRMED — you do not need X mentioned in isolation.

IMPORTANT: The claim may reference multiple authors. You are verifying against ONE source (in the SOURCE
header). Only check whether THIS source supports the substance of the claim. Do not penalise because
other authors mentioned in the claim are absent from this source.

Return ONLY valid JSON:
{"support": "confirmed|likely|plausible|unlikely|rejected", "summary": "...", "reasoning": "...", "cited_passages": [1, 3]}

- "confirmed": Evidence directly confirms or logically entails the claim. The claim does not need to appear verbatim — if the evidence implies it, that counts.
- "likely": Topic is clearly related and the claim is consistent with the evidence, but not directly confirmed. Use when: passages discuss the right topic convincingly, abstract is in the right field, or strong topical alignment.
- "plausible": Some topical overlap; the claim could be in this source but evidence is thin, partial, or tangential. Use when: paywalled content, very short passages, or only loosely related material.
- "unlikely": Weak connection; the evidence barely relates to the claim, or the claim seems like a stretch given what's available.
- "rejected": The source is about a genuinely unrelated topic and there is zero chance it supports the claim — even accounting for the fact that you may not have the full text and that academic works often cover diverse topics. "Contradiction" is NOT grounds for rejection: a passage may present competing views, quote opponents, or describe positions later rebutted. If there is any plausible connection between the source's topic and the claim, do NOT reject.

- "cited_passages": Passage numbers that support the claim. Empty array [] if none.

IMPORTANT: Keep your reasoning brief (under 200 words in your thinking). Budget most of your output tokens for the JSON response.
PROMPT;
    }

    /**
     * Build evidence context instructions based on evidence type.
     */
    private function buildEvidenceContext(string $evidenceType): string
    {
        return match ($evidenceType) {
            'abstract_and_passages', 'passages_only' =>
                "EVIDENCE CONTEXT: The passages below were retrieved by full-text search of the source — " .
                "they are the best matches available, but the search may not have found every relevant passage. " .
                "These are EXCERPTS, not the complete work.\n\n" .
                "Judge the claim against what the passages actually say. If a passage confirms the claim " .
                "(even as part of a broader statement or through logical entailment), that is \"confirmed\". " .
                "If passages discuss the right topic convincingly and the claim is consistent with what you see, " .
                "that is \"likely\". If there is some topical overlap but evidence is thin, partial, or tangential " .
                "(e.g. paywalled stub, very short passages), that is \"plausible\". If the connection is weak or " .
                "the claim seems like a stretch, that is \"unlikely\".\n\n" .
                "REJECTION CRITERIA: Only use \"rejected\" if the source is about a genuinely unrelated topic " .
                "and there is zero chance it supports the claim. Because these are excerpts, apparent " .
                "\"contradiction\" is NOT grounds for rejection — a passage may present a competing view being " .
                "discussed, quote an opponent, or describe a position the author later rebuts. You cannot " .
                "distinguish the author's own position from positions they critique using fragments alone. " .
                "If there is any plausible connection between the source's topic and the claim, do NOT reject.\n\n" .
                "IMPORTANT: The source content may have been fetched from a web page. If the passages and/or " .
                "abstract contain only bibliographic metadata (title, authors, ISBN, BibTeX, publisher info, " .
                "citation formatting) rather than actual article/chapter text, treat this as ABSENT evidence — " .
                "the source was not actually retrieved. In that case, use \"plausible\" if the work's title/topic " .
                "is in the same field as the claim, NOT \"rejected\".\n\n" .
                "IMPORTANT: The passages are EXCERPTS FROM the cited source itself. The source header above " .
                "identifies the work. When a claim says \"Author (Year) argues/discusses/shows X\", your job " .
                "is to check whether X appears in the passages — do NOT look for mentions of the author's name " .
                "within the passages, because authors do not cite themselves in their own text. A year mismatch " .
                "between the claim and source metadata (e.g. 1991 vs 2021) may reflect republication or " .
                "indexing differences — do not treat it as evidence of a wrong source.",
            'web_and_passages', 'web_only' =>
                "EVIDENCE CONTEXT: The content below was scraped from a web page — it may be TRUNCATED or " .
                "INCOMPLETE. Web pages (especially legal judgments, reports, and long articles) are often " .
                "thousands of paragraphs long, and only the first portion may have been retrieved.\n\n" .
                "The full document could contain information not present in what was retrieved. Do NOT assume " .
                "that because a specific claim is not found in this partial content, it does not appear in the " .
                "full document.\n\n" .
                "- \"confirmed\": ONLY if the evidence directly states or logically entails the claim.\n" .
                "- \"likely\": The content discusses the right topic and the claim is consistent with what you see.\n" .
                "- \"plausible\": This is the DEFAULT when the content is in the same field or about the same " .
                "subject — the full page likely contains more detail that was not retrieved.\n" .
                "- \"unlikely\": Weak connection; the content barely relates to the claim.\n" .
                "- \"rejected\": ONLY if the source is about a genuinely unrelated topic and there is zero " .
                "chance it supports the claim. Do NOT reject just because the specific claim text is not " .
                "found — the content may be truncated. Apparent \"contradiction\" is NOT grounds for " .
                "rejection — the content may present competing views, quote opponents, or describe positions " .
                "that are later rebutted in the full document.\n\n" .
                "IMPORTANT: If the content contains only bibliographic metadata (title, authors, ISBN, BibTeX, " .
                "publisher info) rather than actual substantive text, treat this as ABSENT evidence — use " .
                "\"plausible\" if the work's title/topic is in the same field as the claim.\n\n" .
                "IMPORTANT: When a claim says \"Author (Year) argues/discusses/shows X\", check whether X " .
                "appears in the content — do NOT look for mentions of the author's name within the text, " .
                "because authors do not cite themselves in their own work.",
            'title_only' =>
                "EVIDENCE CONTEXT: You only have the TITLE, author, and year of this work — no abstract, " .
                "no passages, no full text.\n\n" .
                "A title is the weakest possible evidence. Works routinely cover far more than their title " .
                "suggests. You cannot infer what a work does or does not contain from its title alone.\n\n" .
                "- \"confirmed\" is NOT possible with title only.\n" .
                "- \"likely\": The title directly mentions the claim's specific topic.\n" .
                "- \"plausible\": The title is in the same broad discipline as the claim. This is the " .
                "DEFAULT for same-field works.\n" .
                "- \"unlikely\": The title suggests a different area and the connection to the claim " .
                "is not obvious.\n" .
                "- \"rejected\": ONLY if the source is about a genuinely unrelated topic (e.g. marine biology " .
                "cited for fiscal policy). Same discipline = NOT \"rejected\" — use \"plausible\" at minimum.\n\n" .
                "When in doubt, default to \"plausible\".",
            default =>
                "EVIDENCE CONTEXT: You only have the abstract of this work — NOT the full text.\n\n" .
                "Step 1: Does the abstract directly confirm or logically entail the claim? If yes → \"confirmed\".\n\n" .
                "Step 2: If not — remember that an abstract is a tiny summary. The vast majority of a work's " .
                "content — argumentation, case studies, literature review, specific findings, historical " .
                "analysis — is NEVER mentioned in the abstract. A claim not appearing in the abstract tells " .
                "you almost nothing about whether it appears in the full text.\n\n" .
                "If the abstract discusses the same topic convincingly and the claim is consistent, use \"likely\". " .
                "If there is some topical overlap but it's thin, use \"plausible\". If the connection is weak, " .
                "use \"unlikely\".\n\n" .
                "Only use \"rejected\" if the abstract reveals the work is about a genuinely unrelated topic " .
                "and there is zero chance it supports the claim (e.g. a marine biology paper cited for " .
                "fiscal policy). An abstract discussing a seemingly opposite position is NOT grounds for " .
                "rejection — the work may critique that position, and the full text may well support the claim. " .
                "If the work is in the same broad field/topic area as the claim, do NOT reject.\n\n" .
                "CRITICAL: Same broad field = NOT \"rejected\". A book about African political economy should not be " .
                "\"rejected\" for a claim about economic development in Africa. \"rejected\" is ONLY for genuinely " .
                "unrelated topics where there is no plausible connection.\n\n" .
                "Step 3: If the abstract IS about a genuinely unrelated topic, flag it explicitly in your " .
                "summary — this likely means the source was incorrectly matched in the bibliography.",
        };
    }

    /**
     * Parse raw LLM response for citation verification.
     */
    private function parseVerifyCitationResult(?string $result): ?array
    {
        if (!$result) {
            return null;
        }

        // Capture <think>...</think> reasoning before stripping (from reasoning models like QwQ)
        preg_match('/<think>([\s\S]*?)<\/think>/i', $result, $thinkMatch);
        $thinking = isset($thinkMatch[1]) ? trim($thinkMatch[1]) : null;

        $result = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $result);

        // Handle unclosed <think> (response truncated mid-reasoning by max_tokens)
        if (str_contains($result, '<think>')) {
            if (!$thinking) {
                preg_match('/<think>([\s\S]*)/i', $result, $unclosedMatch);
                $thinking = isset($unclosedMatch[1]) ? trim($unclosedMatch[1]) : null;
            }
            $result = preg_replace('/<think>[\s\S]*/i', '', $result);
            $result = trim($result);
        }
        $result = trim($result);
        $result = preg_replace('/^```(?:json)?\s*/i', '', $result);
        $result = preg_replace('/\s*```$/', '', $result);

        $parsed = json_decode($result, true);
        if (!is_array($parsed) || !array_key_exists('support', $parsed)) {
            Log::warning('LLM citation verification: invalid JSON response', ['raw' => $result]);
            return null;
        }

        // Validate support value
        $allowed = ['confirmed', 'likely', 'plausible', 'unlikely', 'rejected'];
        if (!in_array($parsed['support'], $allowed, true)) {
            Log::warning('LLM citation verification: invalid support value', ['support' => $parsed['support']]);
            return null;
        }

        $parsed['cited_passages'] = array_filter(
            $parsed['cited_passages'] ?? [],
            fn($v) => is_int($v)
        );

        $parsed['thinking'] = $thinking;

        return $parsed;
    }

    /**
     * Verify whether source material supports a truth claim.
     * Returns {support, summary, reasoning} or null on failure.
     */
    public function verifyCitation(string $truthClaim, string $sourceMaterial, string $evidenceType = 'abstract_only'): ?array
    {
        $evidenceContext = $this->buildEvidenceContext($evidenceType);
        $userMessage = "{$evidenceContext}\n\nTRUTH CLAIM: {$truthClaim}\n\nSOURCE MATERIAL:\n{$sourceMaterial}";

        $result = $this->chat(
            $this->verifyCitationSystemPrompt(),
            $userMessage,
            0.0, 4096, $this->verificationModel, 120, reasoningEffort: null
        );
        return $this->parseVerifyCitationResult($result);
    }

    /**
     * Verify multiple citations concurrently.
     * @param array $items Array of [truthClaim, sourceMaterial, evidenceType]
     * @return array Parsed results keyed same as input (null for failures)
     */
    public function verifyCitationBatch(array $items): array
    {
        $requests = [];
        foreach ($items as $key => [$truthClaim, $sourceMaterial, $evidenceType]) {
            $evidenceContext = $this->buildEvidenceContext($evidenceType);
            $requests[$key] = [
                'system'      => $this->verifyCitationSystemPrompt(),
                'user'        => "{$evidenceContext}\n\nTRUTH CLAIM: {$truthClaim}\n\nSOURCE MATERIAL:\n{$sourceMaterial}",
                'model'       => $this->verificationModel,
                'max_tokens'  => 4096,
                'temperature' => 0.0,
            ];
        }

        $rawResponses = $this->chatBatch($requests, 120);

        $results = [];
        foreach ($rawResponses as $key => $raw) {
            $results[$key] = $this->parseVerifyCitationResult($raw);
        }
        return $results;
    }
}
