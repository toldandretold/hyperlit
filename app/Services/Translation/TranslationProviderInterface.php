<?php

namespace App\Services\Translation;

/**
 * Seam between callers and whatever actually translates.
 *
 * Implementations (selected by config('services.translation.provider') in
 * AppServiceProvider):
 *   HostedProvider    — a general instruct model via LlmService, so BYO-key
 *                       inference tickets pass through for free.
 *   OllamaProvider    — a local specialised model (TranslateGemma / Hy-MT2).
 *   DedicatedProvider — any OpenAI-compatible endpoint: a rented GPU-hour
 *                       deployment or a self-hosted box over Tailscale.
 *
 * Mirrors TtsProviderInterface deliberately — same batch-with-null-on-failure
 * contract, so callers written against one read the same as the other.
 */
interface TranslationProviderInterface
{
    /**
     * Translate one text. Throws TranslationProviderException on failure.
     *
     * @param  string  $targetLang  A canonical LanguageRegistry code (e.g. 'pa-Arab').
     * @param  string|null  $sourceLang  Canonical code, or null to let the model detect it.
     */
    public function translate(string $text, string $targetLang, ?string $sourceLang = null): TranslationResult;

    /**
     * Translate several texts concurrently. Returns results keyed like
     * $textsByKey; a failed key maps to null (caller decides retry/skip).
     *
     * @param  array<string|int, string>  $textsByKey
     * @return array<string|int, TranslationResult|null>
     */
    public function translateBatch(array $textsByKey, string $targetLang, ?string $sourceLang = null): array;

    /** Texts longer than this must be split by the caller before translate. */
    public function maxCharsPerRequest(): int;

    /**
     * Whether this provider's model should be asked for this language at all.
     * False ONLY for an enumerated gap (Hy-MT2 has no Punjabi) — an unverified
     * language returns true and is flagged on the result.
     */
    public function supports(string $targetLang): bool;

    /**
     * The model id that will answer. Billing prices by this, and the registry
     * derives the model family (and therefore support tiers) from it.
     */
    public function modelId(): ?string;

    /**
     * Whether usage through this provider costs the operator money. False for a
     * local Ollama (free) and for a rented endpoint (billed per GPU-hour, so
     * there is no honest per-token rate) — the controller waives the charge
     * rather than invent one.
     */
    public function isBillable(): bool;
}
