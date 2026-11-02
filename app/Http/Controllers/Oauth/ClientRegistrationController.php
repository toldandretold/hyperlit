<?php

namespace App\Http\Controllers\Oauth;

use App\Http\Controllers\Controller;
use App\Services\Oauth\ClientRegistry;
use Illuminate\Http\Request;

/**
 * RFC 7591 Dynamic Client Registration — stateless (see ClientRegistry).
 *
 * claude.ai POSTs its metadata here on first connect and gets back a
 * client_id that encodes the registration. Per RFC 7591 §2, unknown metadata
 * fields are IGNORED, never rejected — clients legitimately send
 * token_endpoint_auth_method, grant_types, logo_uri, etc., and rejecting an
 * unrecognized one bricks the connector for that client forever.
 */
class ClientRegistrationController extends Controller
{
    public function __invoke(Request $request, ClientRegistry $clients)
    {
        $redirectUris = $request->input('redirect_uris');

        if (! is_array($redirectUris) || $redirectUris === []) {
            return $this->oauthError('invalid_client_metadata', 'redirect_uris is required and must be a non-empty array.');
        }

        foreach ($redirectUris as $uri) {
            if (! is_string($uri) || ! $clients->redirectUriAcceptable($uri)) {
                $shown = is_string($uri) ? $uri : gettype($uri);

                return $this->oauthError('invalid_redirect_uri', "Unacceptable redirect URI \"{$shown}\": must be https, or http on a loopback host (localhost / 127.0.0.1).");
            }
        }

        $name = $request->input('client_name') ?? $request->input('name') ?? 'Unnamed client';
        $name = mb_substr(trim(strip_tags((string) $name)), 0, 100) ?: 'Unnamed client';

        $redirectUris = array_values(array_map('strval', $redirectUris));

        return response()->json([
            'client_id' => $clients->issue(['client_name' => $name, 'redirect_uris' => $redirectUris]),
            'client_id_issued_at' => now()->getTimestamp(),
            'client_name' => $name,
            'redirect_uris' => $redirectUris,
            'grant_types' => ['authorization_code', 'refresh_token'],
            'response_types' => ['code'],
            'token_endpoint_auth_method' => 'none',
        ], 201);
    }

    private function oauthError(string $code, string $description)
    {
        // RFC 7591 §3.2.2: registration errors are 400 with this shape.
        return response()->json([
            'error' => $code,
            'error_description' => $description,
        ], 400);
    }
}
