<?php

/**
 * OAuth discovery metadata (RFC 9728 protected resource + RFC 8414
 * authorization server). Claude's client fetches these anonymously with a
 * 10-second timeout before it will show a login — shape drift here bricks
 * the connector silently, so every field Claude keys on is pinned.
 */

test('protected-resource metadata names /mcp and this origin as its authorization server', function () {
    $response = $this->getJson('/.well-known/oauth-protected-resource');

    $response->assertOk();
    expect($response->json('resource'))->toBe(url('/mcp'));
    // Claude uses ONLY authorization_servers[0].
    expect($response->json('authorization_servers.0'))->toBe(url('/'));
    expect($response->json('scopes_supported'))->toContain('read', 'annotate', 'offline_access');
    expect($response->json('bearer_methods_supported'))->toBe(['header']);
});

test('the path-suffixed protected-resource variant answers identically', function () {
    // RFC 9728 clients derive /.well-known/oauth-protected-resource/mcp for a
    // resource at /mcp — and the vendor 401 header points exactly there.
    $bare = $this->getJson('/.well-known/oauth-protected-resource')->json();
    $suffixed = $this->getJson('/.well-known/oauth-protected-resource/mcp');

    $suffixed->assertOk();
    expect($suffixed->json())->toBe($bare);
});

test('authorization-server metadata advertises everything Claude refuses to proceed without', function () {
    $response = $this->getJson('/.well-known/oauth-authorization-server');

    $response->assertOk();
    expect($response->json('issuer'))->toBe(url('/'));
    expect($response->json('authorization_endpoint'))->toBe(url('/oauth/authorize'));
    expect($response->json('token_endpoint'))->toBe(url('/oauth/token'));
    expect($response->json('registration_endpoint'))->toBe(url('/oauth/register'));
    // Claude hard-requires S256 and public-client ("none") support.
    expect($response->json('code_challenge_methods_supported'))->toBe(['S256']);
    expect($response->json('token_endpoint_auth_methods_supported'))->toBe(['none']);
    expect($response->json('grant_types_supported'))->toBe(['authorization_code', 'refresh_token']);
    expect($response->json('response_types_supported'))->toBe(['code']);
    // offline_access advertised → Claude appends it → refresh tokens flow.
    expect($response->json('scopes_supported'))->toContain('offline_access');
});

test('metadata is CORS-open (wildcard, no credentials) for browser MCP clients', function () {
    $response = $this->getJson('/.well-known/oauth-protected-resource');

    expect($response->headers->get('Access-Control-Allow-Origin'))->toBe('*');
    expect($response->headers->has('Access-Control-Allow-Credentials'))->toBeFalse();

    // Preflight on the token endpoint answers without touching the grant logic.
    $preflight = $this->options('/oauth/token', [], ['Origin' => 'https://inspector.example']);
    $preflight->assertNoContent(204);
    expect($preflight->headers->get('Access-Control-Allow-Origin'))->toBe('*');
    expect((string) $preflight->headers->get('Access-Control-Allow-Headers'))->toContain('mcp-protocol-version');
});
