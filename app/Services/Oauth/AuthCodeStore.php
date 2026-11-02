<?php

namespace App\Services\Oauth;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

/**
 * One-time OAuth authorization codes, cache-backed.
 *
 * The cache store is `database` (config/cache.php) and the cache/cache_locks
 * tables are granted to the app role, so codes written by the consent POST
 * (a web-session request) are readable by the token exchange (a stateless
 * request with NO RLS context) — and inside the test transaction under
 * RefreshDatabase. Single use is enforced with an atomic get+forget under a
 * cache lock: an authorization code presented twice is a replay (RFC 6749
 * §4.1.2 requires denial, and leaked-code replay is the attack PKCE + single
 * use exist to kill). Only the sha256 of the code is used as the key, so a
 * cache dump never yields a usable code.
 */
class AuthCodeStore
{
    private const TTL_SECONDS = 300; // 5 minutes — Claude exchanges immediately

    /**
     * @param array{
     *     user_id: int,
     *     client_id: string,
     *     client_name: string,
     *     redirect_uri: string,
     *     code_challenge: string,
     *     scopes: list<string>,
     * } $payload
     */
    public function put(array $payload): string
    {
        $code = 'hac_'.Str::random(64);

        Cache::put($this->key($code), $payload, self::TTL_SECONDS);

        return $code;
    }

    /**
     * Atomic single-use consume: returns the payload once, null ever after.
     */
    public function consume(string $code): ?array
    {
        $key = $this->key($code);

        return Cache::lock($key.':lock', 5)->block(5, function () use ($key) {
            $payload = Cache::get($key);
            if ($payload !== null) {
                Cache::forget($key);
            }

            return is_array($payload) ? $payload : null;
        });
    }

    private function key(string $code): string
    {
        return 'oauth:code:'.hash('sha256', $code);
    }
}
