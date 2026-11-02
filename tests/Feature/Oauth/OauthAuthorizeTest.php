<?php

/**
 * The authorize endpoint's validation ladder + consent flow. The ordering
 * pinned hardest: until BOTH client_id and redirect_uri validate, errors stay
 * on OUR page (400, no Location) — redirecting on an unvalidated URI is an
 * open redirect, and with a code attached it is credential exfiltration.
 */

function authzClientId($test, array $uris = ['https://claude.ai/api/mcp/auth_callback']): string
{
    return $test->postJson('/oauth/register', [
        'redirect_uris' => $uris,
        'client_name' => 'Claude',
    ])->json('client_id');
}

function authzParams(string $clientId, array $overrides = []): array
{
    return array_merge([
        'client_id' => $clientId,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback',
        'response_type' => 'code',
        'state' => 'st4te',
        'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', 'verifier-'.str_repeat('v', 36), true)), '+/', '-_'), '='),
        'code_challenge_method' => 'S256',
        'scope' => 'read annotate offline_access',
    ], $overrides);
}

test('logged out, a valid request renders the login state', function () {
    $clientId = authzClientId($this);

    $response = $this->get('/oauth/authorize?'.http_build_query(authzParams($clientId)));

    $response->assertOk();
    $response->assertSee('Sign in to Hyperlit');
    $response->assertSee('Claude');
});

test('logged in, a valid request renders consent with the client name and redirect host', function () {
    $clientId = authzClientId($this);
    $this->actingAs($this->seedUser(), 'web');

    $response = $this->get('/oauth/authorize?'.http_build_query(authzParams($clientId)));

    $response->assertOk();
    $response->assertSee('Connect Claude?');
    $response->assertSee('claude.ai');
    $response->assertSee('Approve');
});

test('an unknown client_id gets an error PAGE, never a redirect', function () {
    $response = $this->get('/oauth/authorize?'.http_build_query(
        authzParams('hlc_garbage', ['redirect_uri' => 'https://attacker.example/cb'])
    ));

    $response->assertStatus(400);
    expect($response->headers->has('Location'))->toBeFalse();
    $response->assertSee('Connection refused');
});

test('a redirect_uri outside the registration gets an error PAGE, never a redirect', function () {
    $clientId = authzClientId($this);

    $response = $this->get('/oauth/authorize?'.http_build_query(
        authzParams($clientId, ['redirect_uri' => 'https://attacker.example/cb'])
    ));

    $response->assertStatus(400);
    expect($response->headers->has('Location'))->toBeFalse();
    $response->assertSee('Connection refused');
});

test('a missing or non-S256 code_challenge redirects back with error=invalid_request and the state', function () {
    $clientId = authzClientId($this);

    $missing = $this->get('/oauth/authorize?'.http_build_query(
        array_diff_key(authzParams($clientId), ['code_challenge' => true])
    ));
    $missing->assertRedirect();
    expect($missing->headers->get('Location'))
        ->toContain('https://claude.ai/api/mcp/auth_callback?')
        ->toContain('error=invalid_request')
        ->toContain('state=st4te');

    $plain = $this->get('/oauth/authorize?'.http_build_query(
        authzParams($clientId, ['code_challenge_method' => 'plain'])
    ));
    expect($plain->headers->get('Location'))->toContain('error=invalid_request');
});

test('a foreign resource parameter redirects back with error=invalid_target', function () {
    $clientId = authzClientId($this);

    $response = $this->get('/oauth/authorize?'.http_build_query(
        authzParams($clientId, ['resource' => 'https://other.example/mcp'])
    ));

    expect($response->headers->get('Location'))->toContain('error=invalid_target');

    // Our own /mcp URL passes.
    $ok = $this->get('/oauth/authorize?'.http_build_query(
        authzParams($clientId, ['resource' => url('/mcp')])
    ));
    $ok->assertOk();
});

test('a scope request made ONLY of unknown scopes redirects back with error=invalid_scope', function () {
    $clientId = authzClientId($this);

    $response = $this->get('/oauth/authorize?'.http_build_query(
        authzParams($clientId, ['scope' => 'frobnicate wibble'])
    ));

    expect($response->headers->get('Location'))->toContain('error=invalid_scope');
});

test('the decision endpoint requires a web session', function () {
    $clientId = authzClientId($this);

    $this->postJson('/oauth/authorize/decision', authzParams($clientId) + [
        'action' => 'approve', 'scopes' => ['read'],
    ])->assertStatus(401);
});

test('deny sends the client error=access_denied with the state', function () {
    $clientId = authzClientId($this);
    $this->actingAs($this->seedUser(), 'web');

    $response = $this->postJson('/oauth/authorize/decision', authzParams($clientId) + [
        'action' => 'deny',
    ]);

    $response->assertOk();
    expect($response->json('redirect'))
        ->toContain('error=access_denied')
        ->toContain('state=st4te');
});

test('approve issues a code bound to the state, scoped to the consent checkboxes', function () {
    $clientId = authzClientId($this);
    $this->actingAs($this->seedUser(), 'web');

    $response = $this->postJson('/oauth/authorize/decision', authzParams($clientId) + [
        'action' => 'approve',
        'scopes' => ['read', 'annotate'],
    ]);

    $response->assertOk();
    $redirect = (string) $response->json('redirect');
    expect($redirect)->toStartWith('https://claude.ai/api/mcp/auth_callback?')
        ->toContain('state=st4te');
    parse_str((string) parse_url($redirect, PHP_URL_QUERY), $query);
    expect($query['code'])->toStartWith('hac_');
});

test('approve refuses scopes the client never requested, and an empty selection', function () {
    $clientId = authzClientId($this);
    $this->actingAs($this->seedUser(), 'web');

    // 'spend' was not in the requested scope set → silently dropped; with
    // nothing else selected the approval has no usable scope left.
    $this->postJson('/oauth/authorize/decision', authzParams($clientId, ['scope' => 'read']) + [
        'action' => 'approve',
        'scopes' => ['spend'],
    ])->assertStatus(422)->assertJsonPath('error', 'invalid_scope');

    $this->postJson('/oauth/authorize/decision', authzParams($clientId) + [
        'action' => 'approve',
        'scopes' => [],
    ])->assertStatus(422);
});

test('a tampered hidden redirect_uri in the decision POST is refused', function () {
    $clientId = authzClientId($this);
    $this->actingAs($this->seedUser(), 'web');

    $this->postJson('/oauth/authorize/decision', authzParams($clientId, [
        'redirect_uri' => 'https://attacker.example/cb',
    ]) + ['action' => 'approve', 'scopes' => ['read']])
        ->assertStatus(400)
        ->assertJsonPath('error', 'invalid_request');
});
