<?php

namespace App\Services\Oauth;

use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Facades\Crypt;

/**
 * Stateless OAuth client registry (RFC 7591 Dynamic Client Registration
 * without a clients table).
 *
 * A client_id IS its own registration record: an encrypted JSON blob of
 * {client_name, redirect_uris, issued_at} under the APP_KEY. The authorize
 * and token endpoints decrypt it to recover the registered redirect_uris for
 * validation — nothing to store, nothing for DCR spam to grow, nothing to
 * prune. Trade-offs accepted at design time: a registration cannot be
 * individually revoked (a bare registration confers nothing — only tokens do,
 * and those are revocable PATs), and an APP_KEY rotation invalidates every
 * client_id (clients transparently re-register when the server answers
 * invalid_client; claude.ai does this automatically).
 *
 * This class is the redirect-URI security core. The rules:
 * - Registration accepts any https URI, plus http on LOOPBACK hosts only
 *   (localhost / 127.0.0.1 / [::1]) — required for Claude Code's CLI flow.
 * - Matching is EXACT string comparison, except loopback where the PORT is
 *   ignored (RFC 8252 §7.3: native apps bind an ephemeral port per session)
 *   but scheme, host, and path must still match.
 * Both the authorize endpoint AND the token endpoint validate through here;
 * an attacker-chosen redirect_uri is an authorization-code exfiltration
 * channel, so never loosen the match without reading RFC 9700 §4.1 first.
 */
class ClientRegistry
{
    private const PREFIX = 'hlc_';

    private const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

    /**
     * @param  array{client_name: string, redirect_uris: list<string>}  $meta
     */
    public function issue(array $meta): string
    {
        return self::PREFIX.Crypt::encryptString(json_encode([
            'n' => $meta['client_name'],
            'r' => array_values($meta['redirect_uris']),
            'iat' => now()->getTimestamp(),
        ]));
    }

    /**
     * @return array{client_name: string, redirect_uris: list<string>, issued_at: int}|null
     */
    public function resolve(string $clientId): ?array
    {
        if (! str_starts_with($clientId, self::PREFIX)) {
            return null;
        }

        try {
            $decoded = json_decode(Crypt::decryptString(substr($clientId, strlen(self::PREFIX))), true);
        } catch (DecryptException) {
            return null;
        }

        if (! is_array($decoded) || ! is_string($decoded['n'] ?? null) || ! is_array($decoded['r'] ?? null)) {
            return null;
        }

        return [
            'client_name' => $decoded['n'],
            'redirect_uris' => array_values(array_filter($decoded['r'], 'is_string')),
            'issued_at' => (int) ($decoded['iat'] ?? 0),
        ];
    }

    /**
     * Registration-time policy: https anywhere, http only on loopback.
     */
    public function redirectUriAcceptable(string $uri): bool
    {
        $parts = parse_url($uri);
        if ($parts === false || empty($parts['scheme']) || empty($parts['host'])) {
            return false; // relative, javascript:, mailto:, or unparseable
        }

        $scheme = strtolower($parts['scheme']);
        if ($scheme === 'https') {
            return true;
        }

        return $scheme === 'http' && $this->isLoopbackHost($parts['host']);
    }

    /**
     * Authorize/token-time check: exact match, except loopback ignores port.
     *
     * @param  list<string>  $registered
     */
    public function redirectUriMatches(array $registered, string $presented): bool
    {
        foreach ($registered as $candidate) {
            if (hash_equals($candidate, $presented)) {
                return true;
            }

            if ($this->loopbackEquivalent($candidate, $presented)) {
                return true;
            }
        }

        return false;
    }

    private function loopbackEquivalent(string $registered, string $presented): bool
    {
        $a = parse_url($registered);
        $b = parse_url($presented);
        if ($a === false || $b === false) {
            return false;
        }

        $host = strtolower($a['host'] ?? '');
        if (! $this->isLoopbackHost($host)) {
            return false;
        }

        // Port intentionally NOT compared (RFC 8252 §7.3); everything else is.
        return strtolower($b['host'] ?? '-') === $host
            && strtolower($a['scheme'] ?? '') === strtolower($b['scheme'] ?? '-')
            && ($a['path'] ?? '/') === ($b['path'] ?? '-')
            && ($a['query'] ?? null) === ($b['query'] ?? null);
    }

    private function isLoopbackHost(string $host): bool
    {
        return in_array(strtolower($host), self::LOOPBACK_HOSTS, true);
    }
}
