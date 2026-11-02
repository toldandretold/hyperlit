<?php

namespace App\Http\Controllers\Oauth;

use App\Http\Controllers\Controller;
use App\Services\Oauth\OauthScopes;

/**
 * OAuth discovery metadata for the MCP connector flow.
 *
 * Claude's client (claude.ai, mobile, Claude Code) discovers auth from a 401
 * on POST /mcp: the vendor AddWwwAuthenticateHeader middleware points it at
 * the protected-resource document (RFC 9728), whose authorization_servers[0]
 * leads it here for the authorization-server document (RFC 8414). Both routes
 * take an optional {path} suffix because RFC-compliant clients also derive
 * path-suffixed well-known URLs themselves (/.well-known/…/mcp for a resource
 * at /mcp); the answer is the same document either way — one MCP server.
 *
 * Non-negotiables in the AS document (Claude refuses to proceed without
 * them): code_challenge_methods_supported must contain S256, and
 * token_endpoint_auth_methods_supported must contain "none" (Claude is a
 * public client — there is no client secret anywhere in this flow).
 */
class MetadataController extends Controller
{
    public function protectedResource(string $path = '')
    {
        return response()->json([
            'resource' => url('/mcp'),
            'authorization_servers' => [url('/')],
            'scopes_supported' => OauthScopes::supported(),
            'bearer_methods_supported' => ['header'],
            'resource_name' => 'Hyperlit MCP',
        ]);
    }

    public function authorizationServer(string $path = '')
    {
        return response()->json([
            'issuer' => url('/'),
            'authorization_endpoint' => route('oauth.authorize'),
            'token_endpoint' => route('oauth.token'),
            'registration_endpoint' => route('oauth.register'),
            'response_types_supported' => ['code'],
            'grant_types_supported' => ['authorization_code', 'refresh_token'],
            'code_challenge_methods_supported' => ['S256'],
            'token_endpoint_auth_methods_supported' => ['none'],
            'scopes_supported' => OauthScopes::supported(),
        ]);
    }
}
