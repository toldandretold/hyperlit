<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Optional Sanctum auth for the MCP endpoint (/mcp) — four outcomes:
 *
 * - VALID bearer token  → authenticate and continue. We MUST call
 *   Auth::shouldUse('sanctum'): tool code resolves $request->user() via the
 *   DEFAULT guard (laravel/mcp Request::user()), which auth:sanctum used to
 *   repoint on success. Omitting it silently breaks every tool's user().
 *   OAuth-issued access tokens ARE Sanctum PATs (routes/oauth.php), so they
 *   take this exact branch — nothing OAuth-specific lives here.
 * - INVALID / expired / revoked bearer → rich 401 returned DIRECTLY from
 *   here, never via AuthenticationException. Throwing would hand the body to
 *   bootstrap/app.php's generic envelope ("Unauthenticated.", no guidance)
 *   — or, for a client without a JSON Accept header, a 302 redirect to the
 *   POST-only login route. The connecting agent reads this body to learn how
 *   to get the user a token. A bad token must never silently become a guest:
 *   the agent would see the guest tool surface and conclude the token works.
 * - NO bearer, NO ?guest=1 → 401. This is what makes OAuth connectors work:
 *   Claude's client (claude.ai, mobile, Claude Code) starts its OAuth flow
 *   ONLY when a token-less request 401s — the vendor AddWwwAuthenticateHeader
 *   decorates every 401 from this route with `resource_metadata="…"` pointing
 *   at /.well-known/oauth-protected-resource (the route NAME
 *   mcp.oauth.protected-resource is the switch), and that header on a 401 is
 *   the one signal Claude acts on. A 200 guest handshake here would read as
 *   "connected, unauthenticated" and the user would never see a login. The
 *   same mechanism closes the refresh loop: an EXPIRED OAuth PAT lands in the
 *   invalid-bearer 401 above, which now also carries resource_metadata, and
 *   Claude silently refreshes.
 * - NO bearer, WITH ?guest=1 → pass through unauthenticated ("guest").
 *   SetDatabaseSessionContext then sets empty RLS vars (public reads only),
 *   and HyperlitTool::shouldRegister() hides every data tool, leaving just
 *   the get_connected onboarding tool.
 *
 * Declared order on the route is the EXECUTION order (only throttle is in
 * Laravel's $middlewarePriority, and a single listed entry never moves):
 * McpOptionalAuth → throttle:mcp → SetDatabaseSessionContext. Auth first
 * keeps the 'mcp' limiter keyed per-user for token callers (guests share the
 * IP bucket), and the RLS context middleware must always see the resolved
 * user.
 */
class McpOptionalAuth
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = Auth::guard('sanctum')->user();

        if ($user) {
            Auth::shouldUse('sanctum');

            return $next($request);
        }

        if ($request->bearerToken() !== null) {
            return response()->json([
                'success' => false,
                'message' => 'Unauthenticated: the bearer token is invalid, expired, or revoked.',
                'error_type' => 'AuthenticationException',
                'hint' => 'The user can mint a new token at '.rtrim(config('app.url'), '/')
                    .' — log in, open the user button, choose "Data sovereignty", then '
                    .'"MCP for AI access" → "Connect an AI". Send it as the header '
                    .'"Authorization: Bearer <token>".',
                'oauth' => 'Clients with OAuth support can instead re-authorize via the '
                    .'discovery metadata in this response\'s WWW-Authenticate header.',
                'guest_mode' => 'Retry as POST /mcp?guest=1 (no Authorization header) to '
                    .'connect as a guest and get a get_connected onboarding tool that '
                    .'walks the user through setup.',
            ], 401);
        }

        if (! $request->boolean('guest')) {
            return response()->json([
                'success' => false,
                'message' => 'Authentication required.',
                'error_type' => 'AuthenticationException',
                'oauth' => 'OAuth-capable clients (claude.ai, Claude mobile, Claude Code) '
                    .'authorize automatically via the discovery metadata in this '
                    .'response\'s WWW-Authenticate header.',
                'hint' => 'Or send a personal access token as "Authorization: Bearer '
                    .'<token>" — the user can mint one at '.rtrim(config('app.url'), '/')
                    .' via the user button → "Data sovereignty" → "MCP for AI access".',
                'guest_mode' => 'Or retry as POST /mcp?guest=1 to connect as a guest and '
                    .'get a get_connected onboarding tool that walks the user through '
                    .'setup.',
            ], 401);
        }

        return $next($request);
    }
}
