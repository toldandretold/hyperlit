<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Optional Sanctum auth for the MCP endpoint (/mcp) — three outcomes:
 *
 * - VALID bearer token  → authenticate and continue. We MUST call
 *   Auth::shouldUse('sanctum'): tool code resolves $request->user() via the
 *   DEFAULT guard (laravel/mcp Request::user()), which auth:sanctum used to
 *   repoint on success. Omitting it silently breaks every tool's user().
 * - INVALID / expired / revoked bearer → rich 401 returned DIRECTLY from
 *   here, never via AuthenticationException. Throwing would hand the body to
 *   bootstrap/app.php's generic envelope ("Unauthenticated.", no guidance)
 *   — or, for a client without a JSON Accept header, a 302 redirect to the
 *   POST-only login route. The connecting agent reads this body to learn how
 *   to get the user a token. A bad token must never silently become a guest:
 *   the agent would see the guest tool surface and conclude the token works.
 * - NO Authorization header at all → pass through unauthenticated ("guest").
 *   SetDatabaseSessionContext then sets empty RLS vars (public reads only),
 *   and HyperlitTool::shouldRegister() hides every data tool, leaving just
 *   the get_connected onboarding tool.
 *
 * Declared order on the route is the EXECUTION order (only throttle is in
 * Laravel's $middlewarePriority, and a single listed entry never moves):
 * McpOptionalAuth → throttle:mcp → SetDatabaseSessionContext. Auth first
 * keeps the 'mcp' limiter keyed per-user for token callers (guests share the
 * IP bucket), and the RLS context middleware must always see the resolved
 * user. OAuth later: when Mcp::oauthRoutes() + Passport land, this 401 keeps
 * working — laravel/mcp's AddWwwAuthenticateHeader decorates any 401 response
 * and auto-switches to the OAuth resource_metadata discovery form.
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
                'guest_mode' => 'Retry without any Authorization header to connect as a '
                    .'guest and get a get_connected onboarding tool that walks the user '
                    .'through setup.',
            ], 401);
        }

        return $next($request);
    }
}
