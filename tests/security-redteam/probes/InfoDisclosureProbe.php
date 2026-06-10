<?php

namespace RedTeam\Probes;

use RedTeam\Finding;
use RedTeam\Probe;

/**
 * Passive recon: what does the server volunteer about itself before we even
 * attack it? Missing hardening headers, a leaked framework version, and (worst
 * of all) a production app running with APP_DEBUG=true — which turns every
 * uncaught exception into a full stack trace + env dump.
 */
class InfoDisclosureProbe extends Probe
{
    public function name(): string
    {
        return 'Info Disclosure & Headers';
    }

    public function run(): array
    {
        $findings = [];
        $root = $this->ctx->anon->get('/');

        // ---- Security headers ----
        $expected = [
            'x-frame-options'        => ['SAMEORIGIN', 'DENY'],
            'x-content-type-options' => ['nosniff'],
            'content-security-policy'=> null,   // presence-only
            'strict-transport-security' => null,
            'referrer-policy'        => null,
        ];
        $targetIsHttps = str_starts_with($this->ctx->target, 'https://');
        foreach ($expected as $header => $allowed) {
            $val = $root->header($header);
            // HSTS is only meaningful — and only emitted by our middleware — over
            // HTTPS. Don't false-flag it when testing a plain-HTTP local target.
            if ($header === 'strict-transport-security' && !$targetIsHttps) {
                $note = $val === null
                    ? 'absent (expected: HSTS only applies over HTTPS — verify on the prod https host).'
                    : "present: `$val`.";
                $findings[] = $this->inconclusive('HSTS not checked over HTTP', "Target is HTTP; $note", 'GET /');
                continue;
            }
            if ($val === null) {
                $sev = in_array($header, ['x-frame-options', 'x-content-type-options'], true)
                    ? Finding::MEDIUM : Finding::LOW;
                $findings[] = $this->vuln(
                    "Missing response header: $header",
                    $sev,
                    "The server does not send the `$header` header on `/`. " . $this->headerRationale($header),
                    'GET /',
                    '',
                    "Add `$header` via middleware (e.g. a global SecurityHeaders middleware or your web server config)."
                );
            } else {
                $findings[] = $this->safe("Header present: $header", "Server sends `$header: $val`.", 'GET /');
            }
        }

        // ---- Framework / server fingerprint ----
        foreach (['server', 'x-powered-by'] as $h) {
            if ($v = $root->header($h)) {
                if (preg_match('/php\/[\d.]+|laravel|nginx\/[\d.]+|apache\/[\d.]+/i', $v)) {
                    $findings[] = $this->vuln(
                        "Version disclosed in `$h` header",
                        Finding::LOW,
                        "The `$h` header reveals software/version info that helps an attacker target known CVEs.",
                        'GET /',
                        "$h: $v",
                        "Strip or genericise the `$h` header (set `expose_php = Off`, remove `server_tokens`)."
                    );
                }
            }
        }

        // ---- APP_DEBUG leak: force an error and look for a stack trace ----
        // A malformed JSON body / bad route param is the classic way to trip an
        // unhandled exception. We try a route that parses input.
        $probe = $this->ctx->anon->send('POST', '/api/login', '{"email":', ['Content-Type' => 'application/json']);
        if ($probe->looksLikeStackTrace()) {
            $findings[] = $this->vuln(
                'APP_DEBUG appears enabled (stack trace leaked)',
                Finding::HIGH,
                'A malformed request returned a Laravel/PHP stack trace or framework internals in the response body. '
                . 'In production this leaks file paths, env values, and DB structure.',
                'POST /api/login',
                $probe->snippet(400),
                'Set `APP_DEBUG=false` in the production `.env` and clear config cache. Never ship debug mode.'
            );
        } else {
            $findings[] = $this->safe('No stack trace on malformed input', 'Forced parse error did not leak a stack trace.', 'POST /api/login');
        }

        // ---- session-info endpoint (public) over-sharing ----
        $sess = $this->ctx->anon->get('/api/auth/session-info');
        if ($sess->ok()) {
            $body = strtolower($sess->body);
            foreach (['password', 'user_token', 'remember_token', 'api_token', 'secret'] as $leak) {
                if (str_contains($body, $leak)) {
                    $findings[] = $this->vuln(
                        "Public session-info endpoint exposes `$leak`",
                        Finding::HIGH,
                        'The unauthenticated /api/auth/session-info response contains a sensitive field name.',
                        'GET /api/auth/session-info',
                        $sess->snippet(300),
                        'Whitelist the fields returned to anonymous callers; never serialise tokens/secrets.'
                    );
                }
            }
        }

        return $findings;
    }

    private function headerRationale(string $header): string
    {
        return match ($header) {
            'x-frame-options'         => 'Without it the app can be framed for clickjacking.',
            'x-content-type-options'  => 'Without `nosniff` browsers may MIME-sniff responses into executable types.',
            'content-security-policy' => 'A CSP is the main defence-in-depth against injected/stored XSS.',
            'strict-transport-security' => 'HSTS prevents protocol-downgrade / SSL-strip attacks (only meaningful over HTTPS).',
            'referrer-policy'         => 'Limits leaking full URLs (which may contain ids/tokens) to third parties.',
            default                   => '',
        };
    }
}
