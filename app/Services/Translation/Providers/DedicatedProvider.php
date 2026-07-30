<?php

namespace App\Services\Translation\Providers;

use App\Services\Translation\TranslationProviderException;

/**
 * Any OpenAI-compatible endpoint you run yourself. This is the file that makes
 * the hardware question a config change instead of a rewrite — it covers both
 * shapes that "host the specialised model" can take:
 *
 *   A RENTED GPU. DeepInfra custom-LLM deployments serve any Hugging Face repo,
 *   billed per GPU-HOUR rather than per token — A100-80GB at $0.89/hr, which is
 *   ~$650/month always-on, or scale-to-zero via min_instances:0 at the cost of a
 *   multi-minute cold start while the weights load. Every model in question
 *   (TranslateGemma up to 27B, Hy-MT2 up to 30B-A3B) fits on one A100, so model
 *   size is irrelevant — one GPU is the minimum billable unit either way.
 *
 *   YOUR OWN MACHINE. A Mac Studio reached over Tailscale/WireGuard, running
 *   vllm-mlx (which brought PagedAttention-style continuous batching to Metal,
 *   unlike Ollama, whose OLLAMA_NUM_PARALLEL is queue depth rather than real
 *   batching). Good enough to be a queue worker for whole-book translation;
 *   don't expect it to serve hundreds of concurrent interactive requests.
 *
 * ⚠ NOT BILLABLE, and that is a correctness decision rather than generosity: a
 * GPU-hour has no honest per-token rate to charge against. Inventing one would
 * put a fabricated number in the immutable billing ledger. If you ever do want
 * to recover dedicated costs, price it deliberately (an hourly amortisation, or
 * a flat per-book rate) rather than pretending tokens have a price here.
 */
class DedicatedProvider extends OpenAiCompatibleProvider
{
    public function modelId(): ?string
    {
        return config('services.translation.dedicated.model') ?: null;
    }

    public function isBillable(): bool
    {
        return false;
    }

    protected function baseUrl(): string
    {
        $url = (string) config('services.translation.dedicated.base_url', '');

        if (trim($url) === '') {
            throw new TranslationProviderException(
                'TRANSLATION_PROVIDER=dedicated but TRANSLATION_DEDICATED_BASE_URL is unset.'
            );
        }

        return $url;
    }

    protected function apiKey(): ?string
    {
        return config('services.translation.dedicated.api_key') ?: null;
    }

    protected function requestShape(): string
    {
        return (string) config('services.translation.dedicated.request_shape', self::SHAPE_INSTRUCTION);
    }

    protected function label(): string
    {
        return 'Dedicated translation endpoint ('.($this->modelId() ?? 'no model configured').')';
    }
}
