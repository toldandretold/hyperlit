<?php

namespace App\Services\Translation\Providers;

use App\Services\LlmService;
use App\Services\Translation\LanguageRegistry;
use App\Services\Translation\TranslationPrompt;
use App\Services\Translation\TranslationProviderException;
use App\Services\Translation\TranslationProviderInterface;
use App\Services\Translation\TranslationResult;

/**
 * A general instruct model, prompted to translate, over the shared LlmService.
 *
 * WHY THIS RIDES LlmService RATHER THAN ITS OWN HTTP: three things come for
 * free and all three would otherwise have to be rebuilt here —
 *   1. BYO-key inference. ClientTicketTransport is checked INSIDE chat/chatBatch,
 *      so when a user brings their own model this provider is transparently
 *      ticketised with no code path of its own. Own-HTTP would silently bypass it.
 *   2. Per-model usage accounting. BillingService prices from
 *      LlmService::getUsageStats(); a separate HTTP client would report nothing
 *      and translation would be silently unbilled — the exact failure that
 *      shipped twice already for worker-side charges.
 *   3. Retry/backoff on cURL-28, 429 (honouring Retry-After) and 5xx.
 *
 * WHICH MODEL AND ENDPOINT: whatever services.llm.base_url points at, with the
 * model from services.translation.hosted.model. LlmService is already
 * provider-agnostic (any OpenAI-compatible host), so moving translation to
 * DeepInfra's cheaper Gemma 4 is two env vars, not a code change. Note
 * Fireworks serves gemma-4-31b-it on DEDICATED GPUs only, not serverless —
 * hence the Fireworks default here is the general gpt-oss-120b.
 */
class HostedProvider implements TranslationProviderInterface
{
    private ?string $model;

    private float $temperature;

    private int $maxChars;

    private int $batchSize;

    private int $timeout;

    public function __construct(
        private readonly LlmService $llm,
        private readonly LanguageRegistry $registry,
        private readonly TranslationPrompt $prompt,
    ) {
        $this->model = config('services.translation.hosted.model') ?: null;
        $this->temperature = (float) config('services.translation.hosted.temperature', 0.0);
        $this->maxChars = (int) config('services.translation.max_chars_per_request', 4000);
        $this->batchSize = max(1, (int) config('services.translation.batch_size', 30));
        $this->timeout = (int) config('services.translation.timeout', 120);
    }

    public function maxCharsPerRequest(): int
    {
        return $this->maxChars;
    }

    public function modelId(): ?string
    {
        return $this->model;
    }

    public function isBillable(): bool
    {
        return true;
    }

    public function supports(string $targetLang): bool
    {
        return $this->registry->supports($targetLang, $this->registry->familyForModel($this->model));
    }

    public function translate(string $text, string $targetLang, ?string $sourceLang = null): TranslationResult
    {
        $results = $this->translateBatch(['only' => $text], $targetLang, $sourceLang);
        $result = $results['only'] ?? null;

        if (! $result instanceof TranslationResult) {
            throw new TranslationProviderException(
                'Hosted translation failed for model '.($this->model ?? '(default)')
            );
        }

        return $result;
    }

    public function translateBatch(array $textsByKey, string $targetLang, ?string $sourceLang = null): array
    {
        $system = $this->prompt->system($targetLang, $sourceLang);
        $tier = $this->registry->tier($targetLang, $this->registry->familyForModel($this->model));

        $requests = [];
        foreach ($textsByKey as $key => $text) {
            $requests[$key] = [
                'system' => $system,
                'user' => $text,
                'model' => $this->model,
                'temperature' => $this->temperature,
                'max_tokens' => $this->prompt->maxTokensFor($text),
                // Translation is not a reasoning task; 'none' keeps the token
                // budget for output. normaliseReasoningEffort() rewrites this to
                // 'low' for gpt-oss models, which 400 on 'none'.
                'reasoning_effort' => 'none',
            ];
        }

        $results = [];

        // Chunked with a pause between chunks, matching
        // extractCitationMetadataBatch — a 500-node book would otherwise open
        // 500 concurrent connections and get rate-limited into failures.
        $chunks = array_chunk(array_keys($requests), $this->batchSize);
        foreach ($chunks as $chunkIndex => $chunkKeys) {
            $batch = [];
            foreach ($chunkKeys as $k) {
                $batch[$k] = $requests[$k];
            }

            $raw = $this->llm->chatBatch($batch, $this->timeout);

            foreach ($chunkKeys as $k) {
                $answer = $raw[$k] ?? null;
                if (! is_string($answer) || trim($answer) === '') {
                    $results[$k] = null;

                    continue;
                }

                $clean = $this->prompt->clean($answer, (string) $textsByKey[$k]);
                if ($clean === '') {
                    $results[$k] = null;

                    continue;
                }

                $results[$k] = new TranslationResult(
                    text: $clean,
                    targetLang: $targetLang,
                    sourceLang: $sourceLang,
                    model: $this->model,
                    tier: $tier,
                );
            }

            if ($chunkIndex < count($chunks) - 1) {
                usleep(250_000);
            }
        }

        return $results;
    }
}
