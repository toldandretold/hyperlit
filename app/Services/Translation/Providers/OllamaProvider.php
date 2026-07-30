<?php

namespace App\Services\Translation\Providers;

/**
 * A specialised translation model running locally under Ollama.
 *
 *   ollama pull translategemma:4b     # ~2.5GB q4 — comfortable on a 16GB Mac
 *   ollama pull translategemma:12b    # ~7.3GB q4 — cap the context, see below
 *   ollama pull hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M
 *
 * WHY THIS PROVIDER EXISTS AT ALL, given the hosted one is cheaper to operate:
 *   1. E2EE books CANNOT be translated server-side. EncryptedBookGuard nulls
 *      their plainText and the audio feature 403s them outright, for the same
 *      reason: the plaintext must never reach us. On-device translation is not
 *      an optimisation for those books, it is the only mechanism that can exist.
 *   2. Neither specialised open translation model is available per-token from
 *      any host (TranslateGemma and Hy-MT2 both report "not deployed by any
 *      Inference Provider"), so local inference is the ONLY way to evaluate
 *      whether a translation specialist actually beats a general model — which
 *      is the question that decides whether renting a GPU is ever justified.
 *   3. It costs nothing, so it never bills.
 *
 * ⚠ CONTEXT LENGTH on a 16GB machine: translategemma:12b's 128K window will
 * exhaust unified memory through KV cache alone, long before the ~7.3GB of
 * weights become the problem. Run Ollama with OLLAMA_CONTEXT_LENGTH=8192.
 *
 * ⚠ Unauthenticated by design — Ollama listens on localhost with no key. Never
 * point TRANSLATION_OLLAMA_BASE_URL at a remote host without one; use the
 * 'dedicated' provider for anything off-box.
 */
class OllamaProvider extends OpenAiCompatibleProvider
{
    public function modelId(): ?string
    {
        return config('services.translation.ollama.model') ?: null;
    }

    /** Local compute is free — a charge here would bill the user for their own hardware. */
    public function isBillable(): bool
    {
        return false;
    }

    protected function baseUrl(): string
    {
        return (string) config('services.translation.ollama.base_url', 'http://localhost:11434/v1');
    }

    protected function apiKey(): ?string
    {
        return null;
    }

    protected function requestShape(): string
    {
        return (string) config('services.translation.ollama.request_shape', self::SHAPE_AUTO);
    }

    protected function label(): string
    {
        return 'Ollama translation ('.($this->modelId() ?? 'no model configured').')';
    }
}
