<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class SecurityHeaders
{
    /**
     * Security headers to add to all responses.
     */
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        // Prevent clickjacking by disallowing CROSS-ORIGIN framing. SAMEORIGIN
        // (not DENY): the /maintainer triage page frames the reader in an
        // iframe to show a flagged book next to its original PDF — same-origin
        // framing is ours by definition; the clickjacking threat (an attacker
        // page framing us) is cross-origin and stays blocked.
        $response->headers->set('X-Frame-Options', 'SAMEORIGIN');

        // Prevent MIME type sniffing
        $response->headers->set('X-Content-Type-Options', 'nosniff');

        // Enable XSS filter (legacy, but still useful for older browsers)
        $response->headers->set('X-XSS-Protection', '1; mode=block');

        // Control referrer information sent with requests
        $response->headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');

        // Content-Security-Policy.
        //
        // We intentionally lock down only the directives that add real defence
        // WITHOUT risking the SPA or local Vite dev (public/hot) breaking:
        //   - frame-ancestors 'self' : clickjacking protection at the CSP layer
        //                              (complements X-Frame-Options above; 'self'
        //                              not 'none' so /maintainer can frame the reader).
        //   - base-uri 'self'        : blocks an injected <base> tag from
        //                              hijacking every relative URL on the page.
        //   - object-src 'none'      : kills <object>/<embed> plugin-based XSS.
        //   - form-action 'self'     : forms can only POST back to us, so an
        //                              injected form can't exfiltrate to evil.com.
        //
        // We deliberately DO NOT set a restrictive script-src/style-src/connect-src:
        // the app uses inline scripts/styles (which would force 'unsafe-inline',
        // defeating the XSS benefit) and runs Vite HMR + Reverb websockets in dev,
        // which a host allowlist would break. Tightening script-src with per-request
        // nonces is a separate, deliberate hardening pass — see tests/security-redteam.
        $csp = "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'";
        $response->headers->set('Content-Security-Policy', $csp);

        // HSTS: force HTTPS for a year (incl. subdomains). Only emit it over a
        // secure connection — sending it over plain HTTP is meaningless and we
        // don't want it appearing in local http://*.test responses.
        if ($request->secure()) {
            $response->headers->set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }

        // Don't advertise the PHP version. (The `Server:` nginx version banner is
        // added by nginx, not PHP — silence it on the server with `server_tokens
        // off;`. See tests/security-redteam/README.md.)
        $response->headers->remove('X-Powered-By');
        if (function_exists('header_remove')) {
            header_remove('X-Powered-By');
        }

        // Prevent browsers from caching sensitive responses
        if ($request->is('api/*')) {
            $response->headers->set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
            $response->headers->set('Pragma', 'no-cache');
        }

        return $response;
    }
}
