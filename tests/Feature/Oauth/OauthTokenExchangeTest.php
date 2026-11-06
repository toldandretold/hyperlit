<?php

use App\Models\User;
use Illuminate\Support\Str;

/**
 * The token endpoint's authorization_code grant, end to end: register →
 * authorize → decide → exchange → USE the minted token against POST /mcp.
 * The access token is an ordinary Sanctum PAT, so the /mcp leg here is the
 * whole architecture's proof: RLS context, ability gating, and the token UI
 * all see an OAuth connector as just another token.
 *
 * Harness traps (ApiTokenManagementTest's docblock): the consent step uses a
 * web session (actingAs is legitimate THERE), but before any bearer call the
 * session is flushed and guards forgotten — Sanctum consults the web guard
 * before the bearer token, so a lingering session would authenticate every
 * /mcp call no matter what token it carried.
 */

function tokenExchangeVerifier(): string
{
    return 'verifier-'.str_repeat('v', 48);
}

function tokenExchangeChallenge(string $verifier): string
{
    return rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
}

/** Runs register → consent, returns [client_id, code]. Leaves NO session behind. */
function tokenExchangeCode($test, User $user, array $scopes = ['read', 'annotate', 'offline_access'], ?string $verifier = null): array
{
    $clientId = $test->postJson('/oauth/register', [
        'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback'],
        'client_name' => 'Claude',
    ])->json('client_id');

    $test->actingAs($user, 'web');
    $response = $test->postJson('/oauth/authorize/decision', [
        'client_id' => $clientId,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback',
        'response_type' => 'code',
        'state' => 's',
        'code_challenge' => tokenExchangeChallenge($verifier ?? tokenExchangeVerifier()),
        'code_challenge_method' => 'S256',
        'scope' => implode(' ', $scopes),
        'action' => 'approve',
        'scopes' => array_values(array_diff($scopes, ['offline_access'])),
    ]);
    parse_str((string) parse_url((string) $response->json('redirect'), PHP_URL_QUERY), $query);

    $test->flushSession();
    app('auth')->forgetGuards();

    return [$clientId, $query['code'] ?? ''];
}

function tokenExchangeMcp($test, string $token, string $toolName, array $arguments = [])
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call',
        'params' => ['name' => $toolName, 'arguments' => $arguments],
    ], [
        'Authorization' => 'Bearer '.$token,
        'Accept' => 'application/json, text/event-stream',
    ]);
}

test('the full dance yields a working /mcp token with the RFC 6749 response shape', function () {
    $user = $this->seedUser();
    $verifier = tokenExchangeVerifier();
    [$clientId, $code] = tokenExchangeCode($this, $user, verifier: $verifier);
    expect($code)->toStartWith('hac_');

    $response = $this->post('/oauth/token', [
        'grant_type' => 'authorization_code',
        'client_id' => $clientId,
        'code' => $code,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback',
        'code_verifier' => $verifier,
        'resource' => url('/mcp'),
    ], ['Accept' => 'application/json']);

    $response->assertOk();
    expect($response->headers->get('Cache-Control'))->toContain('no-store');
    expect($response->json('token_type'))->toBe('Bearer');
    expect($response->json('expires_in'))->toBeGreaterThan(6 * 24 * 3600)->toBeLessThanOrEqual(7 * 24 * 3600);
    expect($response->json('refresh_token'))->toStartWith('hrt_');
    expect($response->json('scope'))->toContain('read');

    // The minted token IS a PAT: visible on the user, named for the client…
    expect($user->tokens()->pluck('name')->all())->toContain('Claude (OAuth)');

    // …and it WORKS against /mcp with the granted abilities.
    $list = tokenExchangeMcp($this, $response->json('access_token'), 'list_shelves');
    expect($list->json('result.isError'))->not->toBeTrue();
});

test('an OAuth token lives inside the user\'s RLS fence', function () {
    $owner = $this->seedUser();
    $book = 'book_oauth_'.Str::random(6);
    (function () use ($book, $owner): void {
        $this->seedLibrary([
            'book' => $book, 'title' => 'OAuth Fixture Book', 'visibility' => 'private',
            'creator' => $owner->name,
        ]);
        $this->seedNode([
            'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $book.'_1_aaa',
            'content' => '<p id="100" data-node-id="'.$book.'_1_aaa">Sealed prose.</p>',
            'plainText' => 'Sealed prose.',
        ]);
    })->call($this);

    $stranger = $this->seedUser();
    $verifier = tokenExchangeVerifier();
    [$clientId, $code] = tokenExchangeCode($this, $stranger, verifier: $verifier);
    $token = $this->post('/oauth/token', [
        'grant_type' => 'authorization_code', 'client_id' => $clientId, 'code' => $code,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback', 'code_verifier' => $verifier,
    ], ['Accept' => 'application/json'])->json('access_token');

    $read = tokenExchangeMcp($this, $token, 'read_book', ['book' => $book]);
    expect($read->json('result.isError'))->toBeTrue();
    expect((string) ($read->json('result.content.0.text') ?? ''))->not->toContain('Sealed prose');
});

test('granted scopes become PAT abilities — an unselected ability\'s tools are invisible', function () {
    $user = $this->seedUser();
    $verifier = tokenExchangeVerifier();
    // Consent grants annotate only — no read.
    [$clientId, $code] = tokenExchangeCode($this, $user, ['annotate'], $verifier);
    $token = $this->post('/oauth/token', [
        'grant_type' => 'authorization_code', 'client_id' => $clientId, 'code' => $code,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback', 'code_verifier' => $verifier,
    ], ['Accept' => 'application/json'])->json('access_token');

    // Ability-sized listing (HyperlitTool::shouldRegister): a PAT only SEES
    // the tools its abilities allow, and laravel/mcp filters tools/call
    // through the same registration check — so calling an unselected
    // ability's tool is a clean JSON-RPC "not found", not a named refusal
    // (denyUnlessAble remains the call-time gate for session callers).
    $response = tokenExchangeMcp($this, $token, 'list_books');
    expect((string) $response->json('error.message'))->toContain('not found');

    // The listing itself is the capability map: annotate tools present,
    // read tools absent.
    app('auth')->forgetGuards();
    $list = $this->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 2, 'method' => 'tools/list', 'params' => [],
    ], [
        'Authorization' => 'Bearer '.$token,
        'Accept' => 'application/json, text/event-stream',
    ]);
    $names = collect($list->json('result.tools'))->pluck('name');
    expect($names)->toContain('create_highlight');
    expect($names)->not->toContain('list_books');
});

test('a wrong code_verifier is invalid_grant — and the code died with the attempt', function () {
    $user = $this->seedUser();
    $verifier = tokenExchangeVerifier();
    [$clientId, $code] = tokenExchangeCode($this, $user, verifier: $verifier);

    $base = [
        'grant_type' => 'authorization_code', 'client_id' => $clientId, 'code' => $code,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback',
    ];

    $this->post('/oauth/token', $base + ['code_verifier' => 'wrong-'.str_repeat('w', 43)], ['Accept' => 'application/json'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');

    // Codes are SINGLE USE: consumed on first presentation, right or wrong.
    $this->post('/oauth/token', $base + ['code_verifier' => $verifier], ['Accept' => 'application/json'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
});

test('a successful exchange consumes the code — replay is invalid_grant', function () {
    $user = $this->seedUser();
    $verifier = tokenExchangeVerifier();
    [$clientId, $code] = tokenExchangeCode($this, $user, verifier: $verifier);

    $params = [
        'grant_type' => 'authorization_code', 'client_id' => $clientId, 'code' => $code,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback', 'code_verifier' => $verifier,
    ];

    $this->post('/oauth/token', $params, ['Accept' => 'application/json'])->assertOk();
    $this->post('/oauth/token', $params, ['Accept' => 'application/json'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
});

test('redirect_uri and client binding are enforced at exchange time', function () {
    $user = $this->seedUser();
    $verifier = tokenExchangeVerifier();
    [$clientId, $code] = tokenExchangeCode($this, $user, verifier: $verifier);

    // Mismatched redirect_uri → refused (and the code is now consumed).
    $this->post('/oauth/token', [
        'grant_type' => 'authorization_code', 'client_id' => $clientId, 'code' => $code,
        'redirect_uri' => 'https://claude.ai/api/mcp/other', 'code_verifier' => $verifier,
    ], ['Accept' => 'application/json'])->assertStatus(400)->assertJsonPath('error', 'invalid_grant');

    // A DIFFERENT registered client presenting a stolen code → refused.
    $verifier2 = tokenExchangeVerifier();
    [, $code2] = tokenExchangeCode($this, $user, verifier: $verifier2);
    $otherClient = $this->postJson('/oauth/register', [
        'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback'], 'client_name' => 'Other',
    ])->json('client_id');
    $this->post('/oauth/token', [
        'grant_type' => 'authorization_code', 'client_id' => $otherClient, 'code' => $code2,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback', 'code_verifier' => $verifier2,
    ], ['Accept' => 'application/json'])->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
});

test('an expired code is invalid_grant', function () {
    $user = $this->seedUser();
    $verifier = tokenExchangeVerifier();
    [$clientId, $code] = tokenExchangeCode($this, $user, verifier: $verifier);

    $this->travel(6)->minutes(); // code TTL is 5 minutes

    $this->post('/oauth/token', [
        'grant_type' => 'authorization_code', 'client_id' => $clientId, 'code' => $code,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback', 'code_verifier' => $verifier,
    ], ['Accept' => 'application/json'])->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
});

test('an undecryptable client_id is invalid_client (401) and an unknown grant_type is named', function () {
    $this->post('/oauth/token', [
        'grant_type' => 'authorization_code', 'client_id' => 'hlc_garbage',
        'code' => 'hac_x', 'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback',
        'code_verifier' => 'v',
    ], ['Accept' => 'application/json'])->assertStatus(401)->assertJsonPath('error', 'invalid_client');

    $this->post('/oauth/token', ['grant_type' => 'password'], ['Accept' => 'application/json'])
        ->assertStatus(400)->assertJsonPath('error', 'unsupported_grant_type');
});

test('an OAuth-minted PAT cannot mint or revoke PATs', function () {
    // The existing ApiTokenController invariant ("API tokens cannot manage
    // API tokens") must hold for OAuth tokens BECAUSE they are PATs — this is
    // the regression test for anyone who later gives OAuth its own token type.
    $user = $this->seedUser();
    $verifier = tokenExchangeVerifier();
    [$clientId, $code] = tokenExchangeCode($this, $user, verifier: $verifier);
    $token = $this->post('/oauth/token', [
        'grant_type' => 'authorization_code', 'client_id' => $clientId, 'code' => $code,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback', 'code_verifier' => $verifier,
    ], ['Accept' => 'application/json'])->json('access_token');

    app('auth')->forgetGuards();
    $this->postJson('/api/user/api-tokens', [
        'name' => 'escalated', 'abilities' => ['read'],
    ], ['Authorization' => 'Bearer '.$token])->assertStatus(403);
});
