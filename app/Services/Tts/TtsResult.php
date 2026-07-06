<?php

namespace App\Services\Tts;

/**
 * One synthesized utterance. `wordTimestamps` is null for providers that only
 * return audio (DeepInfra); a self-hosted Kokoro provider will populate it
 * ([[word, startMs, endMs], ...]) to enable word-level read-along highlight.
 */
class TtsResult
{
    public function __construct(
        public readonly string $bytes,
        public readonly string $mime = 'audio/mpeg',
        public readonly ?int $durationMs = null,
        public readonly ?array $wordTimestamps = null,
    ) {}
}
