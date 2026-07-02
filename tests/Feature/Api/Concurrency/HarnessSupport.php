<?php

namespace Tests\Feature\Api\Concurrency;

use Illuminate\Support\Facades\Http;

/**
 * Shared support for the LIVE concurrency/latency harness.
 *
 * These tests hit a REAL running server (Herd), not the test DB — the in-process
 * sync-queue feature tests can't fire genuinely-simultaneous requests, so true
 * races (findings F1/F2/F4) can only be observed here. They are non-deterministic
 * and MUST NOT gate CI; they self-skip unless HYPERLIT_TEST_URL is set.
 *
 *   HYPERLIT_TEST_URL=http://hyperlit.test php artisan test --group=concurrency
 *
 * Auth'd race tests also need a Sanctum bearer token for a user that owns a book:
 *   HYPERLIT_TEST_TOKEN=<token> HYPERLIT_TEST_BOOK=<bookId> ...
 */
final class HarnessSupport
{
    /** Base URL of the running server, or null when the harness is disabled. */
    public static function baseUrl(): ?string
    {
        $url = getenv('HYPERLIT_TEST_URL') ?: null;
        return $url ? rtrim($url, '/') : null;
    }

    public static function token(): ?string
    {
        return getenv('HYPERLIT_TEST_TOKEN') ?: null;
    }

    public static function book(): ?string
    {
        return getenv('HYPERLIT_TEST_BOOK') ?: null;
    }

    /** True once we've confirmed the server answers, so a test can skip cleanly. */
    public static function reachable(): bool
    {
        $base = self::baseUrl();
        if (!$base) {
            return false;
        }
        try {
            // Any 2xx/4xx proves the server is up; only a transport error is fatal.
            Http::timeout(5)->get("{$base}/api/auth-check");
            return true;
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
     * Fire $n concurrent GETs at $path and return per-request wall-times (seconds).
     * Reads each response's transferStats — do NOT pass a custom 'on_stats' option;
     * the Laravel client installs its own handler and a user-supplied one never fires.
     *
     * $paths may be a single path (string) or one path per request (array of $n
     * strings) — the latter lets cache-cold rows use a unique query per request.
     */
    public static function poolLatencies(string|array $paths, int $n, array $headers = []): array
    {
        $base = self::baseUrl();
        $responses = Http::pool(fn ($pool) => array_map(
            fn ($i) => $pool->withHeaders($headers)
                ->get($base . (is_array($paths) ? $paths[$i - 1] : $paths)),
            range(1, $n)
        ));

        $times = [];
        foreach ($responses as $r) {
            if ($r instanceof \Illuminate\Http\Client\Response && $r->transferStats) {
                $times[] = $r->transferStats->getTransferTime();
            }
        }

        return [$times, $responses];
    }

    /** p50 / p95 / max over a list of seconds. */
    public static function percentiles(array $times): array
    {
        if (empty($times)) {
            return ['p50' => null, 'p95' => null, 'max' => null, 'n' => 0];
        }
        sort($times);
        $pick = fn (float $q) => $times[(int) floor($q * (count($times) - 1))];
        return [
            'p50' => $pick(0.50),
            'p95' => $pick(0.95),
            'max' => end($times),
            'n'   => count($times),
        ];
    }

    public static function reportRow(string $label, array $p): string
    {
        $ms = fn ($s) => $s === null ? '   -' : sprintf('%4.0fms', $s * 1000);
        return sprintf('  %-38s n=%-3d p50=%s p95=%s max=%s', $label, $p['n'], $ms($p['p50']), $ms($p['p95']), $ms($p['max']));
    }
}
