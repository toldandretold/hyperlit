<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Wildcard, NO-CREDENTIALS CORS for the stateless OAuth endpoints
 * (/.well-known metadata, /oauth/register, /oauth/token).
 *
 * Deliberately separate from config/cors.php + CorsMiddleware: those are
 * CREDENTIALED allowlists (cookies ride along, so origins must be explicit).
 * These endpoints carry no session and no cookie — the request body IS the
 * credential (an auth code or refresh token bound to a PKCE verifier) — so a
 * wildcard origin is safe and required: browser-based MCP clients (the MCP
 * Inspector, future web agents) fetch the metadata and POST the token
 * exchange from arbitrary origins. Anthropic's own claude.ai flow is
 * server-to-server and never needs CORS; this exists for everyone else.
 *
 * Never add Access-Control-Allow-Credentials here, and never mount this on a
 * session-bearing route (the consent page lives in the `web` group instead).
 */
class OauthCors
{
    public function handle(Request $request, Closure $next): Response
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->decorate(response()->noContent(204));
        }

        return $this->decorate($next($request));
    }

    private function decorate(Response $response): Response
    {
        $response->headers->set('Access-Control-Allow-Origin', '*');
        $response->headers->set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        $response->headers->set('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version');
        $response->headers->set('Access-Control-Max-Age', '86400');

        return $response;
    }
}
