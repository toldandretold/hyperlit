<?php

namespace App\Services\OpenAlex;

use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * HTTP transport + politeness layer for the OpenAlex API.
 *
 * Owns the base url / user agent / select-fields constants and every
 * rate-limit behaviour: reactive 429 retry with capped backoff, proactive
 * throttling on a low X-RateLimit-Remaining, and the chunk-of-5 pooled
 * batch loop shared by the DOI-batch and search-batch callers.
 */
class OpenAlexHttpClient
{
    public const BASE_URL = 'https://api.openalex.org';
    public const USER_AGENT = 'Hyperlit/1.0 (mailto:sam@hyperlit.io)';
    public const SELECT_FIELDS = 'id,title,authorships,publication_year,primary_location,best_oa_location,doi,biblio,open_access,type,language,cited_by_count,abstract_inverted_index';

    /**
     * Make an HTTP GET request with retry logic for 429 rate limiting.
     * Retries up to 3 times with exponential backoff (1s, 2s, 4s).
     * Proactively sleeps when X-RateLimit-Remaining drops below threshold.
     *
     * $userFacing=true suppresses the proactive sleep on low remaining-quota
     * (still logs). Cron callers should leave it false so they back off politely;
     * user-facing callers (citation search) shouldn't pay 1–2s of sleep per request
     * just because the daily quota is running low.
     */
    public function retryableGet(string $url, array $query = [], bool $userFacing = false): Response
    {
        $maxRetries = 3;

        for ($attempt = 0; $attempt <= $maxRetries; $attempt++) {
            // 10s connect / 15s total. OpenAlex is usually <1s; without a cap we'd
            // block the synchronous import-inspect path for the full 30s PHP default
            // if OpenAlex is slow.
            $response = Http::withHeaders([
                'User-Agent' => self::USER_AGENT,
            ])->connectTimeout(10)->timeout(15)->get($url, $query);

            if ($response->status() !== 429 || $attempt === $maxRetries) {
                // Proactive throttle: sleep when remaining requests are low
                $this->proactiveThrottle($response, $userFacing);
                return $response;
            }

            $retryAfter = (int) ($response->header('Retry-After') ?: 0);
            $maxBackoff = 10;
            $backoff = $retryAfter > 0 ? min($retryAfter, $maxBackoff) : pow(2, $attempt);

            if ($retryAfter > $maxBackoff) {
                Log::warning('OpenAlex Retry-After exceeds cap', [
                    'retry_after' => $retryAfter,
                    'capped_to'   => $maxBackoff,
                ]);
            }

            Log::info('OpenAlex 429 rate limited, retrying', [
                'attempt'     => $attempt + 1,
                'backoff_sec' => $backoff,
                'url'         => $url,
            ]);

            sleep($backoff);
        }

        return $response; // unreachable, but satisfies static analysis
    }

    /**
     * Check X-RateLimit-Remaining header and proactively sleep when low.
     * Prevents hitting 429s by backing off before the limit is reached.
     *
     * When $userFacing=true we log but do NOT sleep — a user typing in the citation
     * modal shouldn't pay 1–2s every request just because cron jobs ate the quota.
     */
    public function proactiveThrottle(Response $response, bool $userFacing = false): void
    {
        $remaining = $response->header('X-RateLimit-Remaining');

        // Laravel's header() yields '' (not null) when the header is absent —
        // treating that as 0 made every background call sleep 2s for nothing.
        if ($remaining === null || $remaining === '') {
            return;
        }

        $remaining = (int) $remaining;

        if ($remaining < 20) {
            Log::info('OpenAlex rate limit low' . ($userFacing ? ' (user-facing, no sleep)' : ', proactive throttle'), [
                'remaining' => $remaining,
                'sleep_sec' => $userFacing ? 0 : 2,
            ]);
            if (!$userFacing) {
                sleep(2);
            }
        } elseif ($remaining < 50) {
            Log::info('OpenAlex rate limit approaching' . ($userFacing ? ' (user-facing, no sleep)' : ', proactive throttle'), [
                'remaining' => $remaining,
                'sleep_sec' => $userFacing ? 0 : 1,
            ]);
            if (!$userFacing) {
                sleep(1);
            }
        }
    }

    /**
     * Run many GETs concurrently in chunks of 5 with a 1s inter-chunk gap to
     * stay under OpenAlex's 10 req/s polite limit. Skips 429'd requests
     * (they get $failureValue and can be retried in a later wave), raises the
     * inter-chunk gap to 3s when throttled, and watches X-RateLimit-Remaining
     * for proactive slow-down. This is the shared body of the DOI-batch and
     * search-batch loops.
     *
     * @param array    $requests     key => ['url' => string, 'query' => array]
     * @param callable $handle       fn(Response): mixed — maps a non-429 response to a result
     * @param mixed    $failureValue result recorded for missing or 429'd responses
     * @param string   $label        log label, e.g. 'batch DOI' / 'batch search'
     */
    public function pooledGet(array $requests, callable $handle, mixed $failureValue, string $label): array
    {
        if (empty($requests)) {
            return [];
        }

        $allResults = [];
        $keys = array_keys($requests);
        $chunks = array_chunk($keys, 5);
        $throttled = false;

        foreach ($chunks as $chunkIndex => $chunkKeys) {
            $responses = Http::pool(function (Pool $pool) use ($requests, $chunkKeys) {
                foreach ($chunkKeys as $key) {
                    $pool->as((string) $key)
                        ->withHeaders(['User-Agent' => self::USER_AGENT])
                        ->timeout(15)
                        ->get($requests[$key]['url'], $requests[$key]['query'] ?? []);
                }
            });

            $had429 = false;
            $lowestRemaining = PHP_INT_MAX;

            foreach ($chunkKeys as $key) {
                $response = $responses[(string) $key] ?? null;
                if (!$response instanceof Response) {
                    $allResults[$key] = $failureValue;
                    continue;
                }

                // Skip 429s — the entry will fail this wave and can be retried in a later wave
                if ($response->status() === 429) {
                    Log::warning("OpenAlex {$label} 429, skipping", ['url' => $requests[$key]['url']]);
                    $allResults[$key] = $failureValue;
                    $had429 = true;
                    continue;
                }

                if ($response->successful()) {
                    $allResults[$key] = $handle($response);

                    // Track lowest remaining across this chunk's responses
                    $remaining = $response->header('X-RateLimit-Remaining');
                    if ($remaining !== null) {
                        $lowestRemaining = min($lowestRemaining, (int) $remaining);
                    }
                } else {
                    $allResults[$key] = $failureValue;
                }
            }

            if ($had429) {
                $throttled = true;
            }

            if ($chunkIndex < count($chunks) - 1) {
                // Proactive throttle based on remaining quota
                if ($lowestRemaining < 20) {
                    Log::info("OpenAlex {$label}: rate limit low, sleeping 3s", ['remaining' => $lowestRemaining]);
                    sleep(3);
                } elseif ($throttled || $lowestRemaining < 50) {
                    sleep($throttled ? 3 : 2);
                } else {
                    sleep(1);
                }
            }
        }

        return $allResults;
    }
}
