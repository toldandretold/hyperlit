<?php

use App\Services\Oauth\ClientRegistry;

/**
 * RFC 7591 Dynamic Client Registration — stateless (the client_id IS the
 * encrypted registration; see ClientRegistry). The redirect-URI acceptance
 * rules pinned here are the security policy: https anywhere, http on
 * loopback only, nothing unparseable.
 */

test('registration returns a resolvable stateless client_id', function () {
    $response = $this->postJson('/oauth/register', [
        'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback'],
        'client_name' => 'Claude',
        // RFC 7591: unknown metadata is IGNORED, never rejected.
        'token_endpoint_auth_method' => 'none',
        'logo_uri' => 'https://claude.ai/logo.png',
        'some_future_field' => ['x'],
    ]);

    $response->assertCreated();
    expect($response->json('client_name'))->toBe('Claude');
    expect($response->json('token_endpoint_auth_method'))->toBe('none');
    expect($response->json('client_id_issued_at'))->toBeInt();

    $resolved = app(ClientRegistry::class)->resolve($response->json('client_id'));
    expect($resolved)->not->toBeNull();
    expect($resolved['client_name'])->toBe('Claude');
    expect($resolved['redirect_uris'])->toBe(['https://claude.ai/api/mcp/auth_callback']);
});

test('registration requires a non-empty redirect_uris array', function () {
    $this->postJson('/oauth/register', ['client_name' => 'X'])
        ->assertStatus(400)
        ->assertJsonPath('error', 'invalid_client_metadata');

    $this->postJson('/oauth/register', ['redirect_uris' => []])
        ->assertStatus(400)
        ->assertJsonPath('error', 'invalid_client_metadata');
});

test('plain-http non-loopback, javascript:, and relative redirect URIs are refused', function () {
    foreach (['http://evil.example/cb', 'javascript:alert(1)', '/relative/cb', 'claude.ai/cb'] as $bad) {
        $this->postJson('/oauth/register', ['redirect_uris' => [$bad]])
            ->assertStatus(400)
            ->assertJsonPath('error', 'invalid_redirect_uri');
    }

    // One bad URI poisons the whole registration — no partial acceptance.
    $this->postJson('/oauth/register', [
        'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback', 'http://evil.example/cb'],
    ])->assertStatus(400);
});

test('http loopback redirect URIs are accepted with any port (Claude Code)', function () {
    foreach (['http://localhost/callback', 'http://127.0.0.1:51234/callback', 'http://[::1]:8080/cb'] as $uri) {
        $this->postJson('/oauth/register', ['redirect_uris' => [$uri]])->assertCreated();
    }
});

test('the client name is sanitized and bounded', function () {
    $response = $this->postJson('/oauth/register', [
        'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback'],
        'client_name' => '  <script>alert(1)</script>'.str_repeat('N', 300),
    ]);

    $response->assertCreated();
    $name = $response->json('client_name');
    expect($name)->not->toContain('<script>');
    expect(mb_strlen($name))->toBeLessThanOrEqual(100);
});

test('loopback matching ignores the port but nothing else', function () {
    $registry = app(ClientRegistry::class);
    $registered = ['http://localhost/callback', 'https://claude.ai/api/mcp/auth_callback'];

    expect($registry->redirectUriMatches($registered, 'http://localhost:60123/callback'))->toBeTrue();
    expect($registry->redirectUriMatches($registered, 'http://localhost:60123/other'))->toBeFalse();
    expect($registry->redirectUriMatches($registered, 'https://claude.ai/api/mcp/auth_callback'))->toBeTrue();
    // Exact-match rule: a DIFFERENT https path/host never matches.
    expect($registry->redirectUriMatches($registered, 'https://claude.ai/api/mcp/auth_callback2'))->toBeFalse();
    expect($registry->redirectUriMatches($registered, 'https://claude.ai.evil.example/api/mcp/auth_callback'))->toBeFalse();
    // Port-agnosticism must NEVER extend to non-loopback hosts.
    expect($registry->redirectUriMatches(['https://claude.ai/cb'], 'https://claude.ai:8443/cb'))->toBeFalse();
});
