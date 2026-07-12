<?php

namespace App\Services\SourceImport\Content;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Client for a self-hosted FlareSolverr (https://github.com/FlareSolverr/FlareSolverr)
 * — a proxy that runs a real browser to solve Cloudflare "Just a moment…" JS
 * challenges and returns the cleared session (cookies + user-agent + HTML).
 *
 * Opt-in and self-hosted: driven entirely by config('services.flaresolverr.url')
 * (env FLARESOLVERR_URL, e.g. http://127.0.0.1:8191). When unset, isConfigured()
 * is false and the whole Cloudflare-solver strategy no-ops — dev and prod
 * without the container behave exactly as before.
 *
 * Deploy: `docker run -d -p 8191:8191 --restart unless-stopped
 * ghcr.io/flaresolverr/flaresolverr:latest`, then set FLARESOLVERR_URL.
 * See deploy/oa-fetch-hardening.md.
 */
class FlareSolverrClient
{
    public function isConfigured(): bool
    {
        return (bool) $this->baseUrl();
    }

    private function baseUrl(): ?string
    {
        return config('services.flaresolverr.url') ?: null;
    }

    /**
     * Solve a URL through FlareSolverr. Returns the cleared session on success:
     *   ['html' => string, 'cookies' => array<int,array>, 'user_agent' => string, 'url' => string]
     * or null if not configured / the solve failed.
     */
    public function solve(string $url): ?array
    {
        $base = $this->baseUrl();
        if (!$base) {
            return null;
        }

        $maxTimeoutMs = (int) config('services.flaresolverr.max_timeout', 60000);
        $proxy = config('services.source_fetch.proxy') ?: env('SOURCE_FETCH_PROXY');

        $payload = [
            'cmd'        => 'request.get',
            'url'        => $url,
            'maxTimeout' => $maxTimeoutMs,
        ];
        if ($proxy) {
            // FlareSolverr can egress through the same residential proxy.
            $payload['proxy'] = ['url' => $proxy];
        }

        try {
            // A real browser solve is slow — give the HTTP call the same budget
            // as the solver plus headroom.
            $resp = Http::timeout((int) ceil($maxTimeoutMs / 1000) + 15)
                ->asJson()
                ->post(rtrim($base, '/') . '/v1', $payload);

            if (!$resp->successful() || $resp->json('status') !== 'ok') {
                Log::warning('FlareSolverr solve did not return ok', [
                    'url'    => $url,
                    'status' => $resp->json('status'),
                    'msg'    => $resp->json('message'),
                ]);
                return null;
            }

            $solution = $resp->json('solution') ?? [];
            return [
                'html'       => $solution['response'] ?? '',
                'cookies'    => $solution['cookies'] ?? [],
                'user_agent' => $solution['userAgent'] ?? null,
                'url'        => $solution['url'] ?? $url,
            ];
        } catch (\Throwable $e) {
            Log::warning('FlareSolverr request failed', ['url' => $url, 'error' => $e->getMessage()]);
            return null;
        }
    }
}
