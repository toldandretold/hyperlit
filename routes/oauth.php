<?php

use App\Http\Controllers\Oauth\AuthorizationController;
use App\Http\Controllers\Oauth\ClientRegistrationController;
use App\Http\Controllers\Oauth\MetadataController;
use App\Http\Controllers\Oauth\TokenController;
use App\Http\Middleware\OauthCors;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| OAuth for MCP connectors — thin OAuth 2.1 layer over Sanctum
|--------------------------------------------------------------------------
|
| Lets claude.ai / the Claude mobile app / Claude Code connect to /mcp via
| OAuth instead of a pasted token. The token endpoint ultimately mints an
| ORDINARY Sanctum personal access token (HyperlitPersonalAccessToken), so
| everything downstream — McpOptionalAuth, SetDatabaseSessionContext's RLS
| bearer fallback, TokenAbilities gating, the "MCP for AI access" UI where
| the token is visible and revocable — is the exact same machinery as a
| hand-minted token. No Passport. docs/mcp.md has the full map.
|
| Two deliberate registration choices:
|
| 1. The stateless endpoints (metadata, register, token) are registered with
|    NO middleware group — the same way the vendor loads routes/ai.php. That
|    means no session, no cookies, and crucially NO CSRF (ValidateCsrfTokens
|    lives in the `web` group), so nothing needs adding to the exemption list
|    in bootstrap/app.php. They carry OauthCors (wildcard, no credentials)
|    and named throttles instead. The consent pair lives in the full `web`
|    group: it NEEDS the session (who is approving?) and CSRF (the approval
|    POST is a state-changing same-origin form).
|
| 2. The protected-resource route's NAME is load-bearing: laravel/mcp's
|    AddWwwAuthenticateHeader (always on /mcp) checks for a route named
|    `mcp.oauth.protected-resource` and, when present, decorates every 401
|    with `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<this
|    route, path={request path}>"` — which is the ONLY trigger Claude's
|    client acts on to start OAuth discovery. Rename it and connectors
|    silently stop offering login while everything else still passes.
|
| The {path?} suffix on both well-known routes mirrors the vendor shape:
| RFC 9728/8414 clients derive path-suffixed metadata URLs for a resource at
| /mcp (/.well-known/oauth-protected-resource/mcp); same document either way.
*/

Route::get('/.well-known/oauth-protected-resource/{path?}', [MetadataController::class, 'protectedResource'])
    ->where('path', '.*')
    ->name('mcp.oauth.protected-resource')
    ->middleware([OauthCors::class, 'throttle:oauth-metadata']);

Route::get('/.well-known/oauth-authorization-server/{path?}', [MetadataController::class, 'authorizationServer'])
    ->where('path', '.*')
    ->name('mcp.oauth.authorization-server')
    ->middleware([OauthCors::class, 'throttle:oauth-metadata']);

Route::post('/oauth/register', ClientRegistrationController::class)
    ->name('oauth.register')
    ->middleware([OauthCors::class, 'throttle:oauth-register']);

Route::post('/oauth/token', TokenController::class)
    ->name('oauth.token')
    ->middleware([OauthCors::class, 'throttle:oauth-token']);

// Explicit preflights (these paths have no GET, so nothing else answers OPTIONS).
Route::options('/oauth/register', fn () => response()->noContent())->middleware(OauthCors::class);
Route::options('/oauth/token', fn () => response()->noContent())->middleware(OauthCors::class);

// Consent: session + CSRF + SecurityHeaders + SetDatabaseSessionContext.
Route::middleware(['web', 'throttle:oauth-authorize'])->group(function () {
    Route::get('/oauth/authorize', [AuthorizationController::class, 'show'])->name('oauth.authorize');
    Route::post('/oauth/authorize/decision', [AuthorizationController::class, 'decide'])->name('oauth.authorize.decision');
});
