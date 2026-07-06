<?php

namespace App\Services\Tts;

/**
 * Seam between GenerateBookAudioJob and whatever synthesizes speech.
 * Implementations: DeepInfraKokoroProvider (hosted API, v1). A future
 * SelfHostedKokoroProvider (droplet Python service) swaps in via
 * config('services.tts.provider') and adds word timestamps.
 */
interface TtsProviderInterface
{
    /**
     * Synthesize one text. Throws TtsProviderException on failure.
     */
    public function synthesize(string $text, string $voice): TtsResult;

    /**
     * Synthesize several texts concurrently. Returns results keyed like
     * $textsByKey; a failed key maps to null (caller decides retry/skip).
     *
     * @param  array<string|int, string>  $textsByKey
     * @return array<string|int, TtsResult|null>
     */
    public function synthesizeBatch(array $textsByKey, string $voice): array;

    /** Texts longer than this must be split by the caller before synthesize. */
    public function maxCharsPerRequest(): int;
}
