<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Inspects the flags on the cookies the server sets. The session cookie is the
 * keys-to-the-kingdom — if it lacks `HttpOnly`, any XSS can read and exfiltrate
 * it (full account takeover); without `SameSite` it's exposed to CSRF; without
 * `Secure` (over HTTPS) it can leak over a downgraded HTTP request.
 *
 * Note: `XSRF-TOKEN` is intentionally NOT HttpOnly — the SPA's JS must read it
 * to echo it back as the X-XSRF-TOKEN header, so we treat a readable XSRF-TOKEN
 * as expected, not a finding. The session cookie is the one that must be locked.
 */
class CookieSecurityProbe extends Probe
{
    public function name(): string
    {
        return 'Cookie Security';
    }

    public function run(): array
    {
        $findings = [];
        $resp = $this->ctx->anon->get('/');
        $setCookies = $resp->headers['set-cookie'] ?? [];

        if (!$setCookies) {
            return [$this->inconclusive('No cookies observed', 'GET / set no cookies — re-check against a route that starts a session.', 'GET /')];
        }

        $targetIsHttps = str_starts_with($this->ctx->target, 'https://');

        foreach ($setCookies as $raw) {
            $name  = trim(explode('=', $raw, 2)[0]);
            $lower = strtolower($raw);
            $isSession = str_contains($lower, 'session');
            $isXsrf    = stripos($name, 'xsrf') !== false;

            $httpOnly = str_contains($lower, 'httponly');
            $sameSite = str_contains($lower, 'samesite');
            $secure   = str_contains($lower, 'secure');

            // --- HttpOnly (session cookie only) ---
            if ($isSession && !$httpOnly) {
                $findings[] = $this->vuln(
                    "Session cookie `$name` missing HttpOnly",
                    Finding::HIGH,
                    'The session cookie is readable from JavaScript, so any XSS can steal it and hijack the session.',
                    'GET /',
                    $this->redact($raw),
                    'Set `http_only => true` for the session cookie (config/session.php SESSION_HTTP_ONLY=true).'
                );
            } elseif ($isSession) {
                $findings[] = $this->safe("Session cookie `$name` is HttpOnly", 'Not readable from JS.', 'GET /');
            }

            // --- SameSite (all cookies) ---
            if (!$sameSite) {
                $findings[] = $this->vuln(
                    "Cookie `$name` missing SameSite",
                    $isSession ? Finding::MEDIUM : Finding::LOW,
                    'Without a SameSite attribute the cookie is attached to cross-site requests, widening CSRF exposure.',
                    'GET /',
                    $this->redact($raw),
                    'Set `same_site => "lax"` (or "strict") in config/session.php.'
                );
            } else {
                $findings[] = $this->safe("Cookie `$name` sets SameSite", 'Restricts cross-site sending.', 'GET /');
            }

            // --- Secure (only assertable / required over HTTPS) ---
            if ($isSession) {
                if ($targetIsHttps && !$secure) {
                    $findings[] = $this->vuln(
                        "Session cookie `$name` missing Secure (over HTTPS)",
                        Finding::MEDIUM,
                        'Served over HTTPS without the Secure flag, so the cookie can leak over a downgraded HTTP request.',
                        'GET /',
                        $this->redact($raw),
                        'Set SESSION_SECURE_COOKIE=true in the production env.'
                    );
                } elseif (!$targetIsHttps) {
                    $findings[] = $this->inconclusive(
                        "Secure flag on `$name` not assertable over HTTP",
                        'Target is HTTP so the Secure flag is correctly absent; ensure SESSION_SECURE_COOKIE=true in prod (currently unset).',
                        'GET /'
                    );
                } else {
                    $findings[] = $this->safe("Session cookie `$name` is Secure", 'Marked Secure over HTTPS.', 'GET /');
                }
            }

            if ($isXsrf && !$httpOnly) {
                $findings[] = $this->safe("XSRF-TOKEN readable by JS (expected)", 'The CSRF token cookie is intentionally non-HttpOnly so the SPA can echo it back.', 'GET /');
            }
        }

        return $findings;
    }

    /** Keep the flags, drop the (sensitive) cookie value from evidence. */
    private function redact(string $raw): string
    {
        return preg_replace('/=([^;]{0,8})[^;]*/', '=$1…', $raw, 1) ?? $raw;
    }
}
