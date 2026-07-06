<?php

namespace App\Services\Tts;

use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/**
 * Hosted Kokoro-82M via DeepInfra's inference API. Requests MP3 output
 * directly so no server-side transcode is needed. Response carries the audio
 * as a base64 data URI in the `audio` field.
 */
class DeepInfraKokoroProvider implements TtsProviderInterface
{
    private string $baseUrl;

    private string $apiKey;

    private int $maxChars;

    private int $concurrency;

    public function __construct()
    {
        $this->baseUrl = rtrim((string) config('services.tts.base_url', ''), '/');
        $this->apiKey = (string) config('services.tts.api_key', '');
        $this->maxChars = (int) config('services.tts.max_chars_per_request', 1500);
        $this->concurrency = max(1, (int) config('services.tts.concurrency', 5));
    }

    public function maxCharsPerRequest(): int
    {
        return $this->maxChars;
    }

    public function synthesize(string $text, string $voice): TtsResult
    {
        $response = Http::withHeaders(['Authorization' => 'Bearer '.$this->apiKey])
            ->timeout(120)
            ->post($this->baseUrl, $this->payload($text, $voice));

        return $this->parse($response);
    }

    public function synthesizeBatch(array $textsByKey, string $voice): array
    {
        $results = [];

        foreach (array_chunk($textsByKey, $this->concurrency, true) as $chunk) {
            $responses = Http::pool(function ($pool) use ($chunk, $voice) {
                $requests = [];
                foreach ($chunk as $key => $text) {
                    $requests[] = $pool->as((string) $key)
                        ->withHeaders(['Authorization' => 'Bearer '.$this->apiKey])
                        ->timeout(120)
                        ->post($this->baseUrl, $this->payload($text, $voice));
                }

                return $requests;
            });

            foreach ($chunk as $key => $_text) {
                $response = $responses[(string) $key] ?? null;
                try {
                    $results[$key] = ($response instanceof Response)
                        ? $this->parse($response)
                        : null; // pool yields a Throwable on connection failure
                } catch (TtsProviderException) {
                    $results[$key] = null;
                }
            }
        }

        return $results;
    }

    private function payload(string $text, string $voice): array
    {
        return [
            'text' => $text,
            'preset_voice' => [$voice],
            'output_format' => 'mp3',
        ];
    }

    private function parse(Response $response): TtsResult
    {
        if (! $response->successful()) {
            throw new TtsProviderException(
                'DeepInfra TTS HTTP '.$response->status().': '.substr($response->body(), 0, 500)
            );
        }

        $audio = $response->json('audio');
        if (! is_string($audio) || $audio === '') {
            throw new TtsProviderException('DeepInfra TTS response missing audio field');
        }

        // Audio arrives as a data URI ("data:audio/mp3;base64,....") or bare base64.
        if (str_starts_with($audio, 'data:')) {
            $comma = strpos($audio, ',');
            $audio = $comma === false ? '' : substr($audio, $comma + 1);
        }

        $bytes = base64_decode($audio, true);
        if ($bytes === false || $bytes === '') {
            throw new TtsProviderException('DeepInfra TTS returned undecodable audio');
        }

        return new TtsResult(bytes: $bytes, mime: 'audio/mpeg');
    }
}
