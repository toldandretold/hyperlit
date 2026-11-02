<?php

use App\Models\OauthRefreshToken;
use App\Models\User;

/**
 * The refresh_token grant: rotation, reuse detection (family revocation),
 * UI-revoke honoring, and expiry. Rotation model: each refresh use mints a
 * NEW PAT + refresh pair in the same family, deletes the old PAT, and
 * tombstones the old refresh row — presenting a tombstoned token again is
 * theft evidence and kills the family.
 */

function refreshVerifier(): string
{
    return 'verifier-'.str_repeat('r', 48);
}

/** Full dance → ['access' => …, 'refresh' => …] for $user. No session left behind. */
function refreshDance($test, User $user, array $scopes = ['read', 'offline_access']): array
{
    $clientId = $test->postJson('/oauth/register', [
        'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback'],
        'client_name' => 'Claude',
    ])->json('client_id');

    $verifier = refreshVerifier();
    $test->actingAs($user, 'web');
    $decision = $test->postJson('/oauth/authorize/decision', [
        'client_id' => $clientId,
        'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback',
        'response_type' => 'code',
        'state' => 's',
        'code_challenge' => rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '='),
        'code_challenge_method' => 'S256',
        'scope' => implode(' ', $scopes),
        'action' => 'approve',
        'scopes' => array_values(array_diff($scopes, ['offline_access'])),
    ]);
    parse_str((string) parse_url((string) $decision->json('redirect'), PHP_URL_QUERY), $query);
    $test->flushSession();
    app('auth')->forgetGuards();

    $granted = $test->post('/oauth/token', [
        'grant_type' => 'authorization_code', 'client_id' => $clientId,
        'code' => $query['code'], 'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback',
        'code_verifier' => $verifier,
    ], ['Accept' => 'application/json'])->json();

    return ['access' => $granted['access_token'], 'refresh' => $granted['refresh_token'], 'client_id' => $clientId];
}

function refreshGrant($test, string $refreshToken)
{
    return $test->post('/oauth/token', [
        'grant_type' => 'refresh_token',
        'refresh_token' => $refreshToken,
    ], ['Accept' => 'application/json']);
}

function refreshMcpList($test, string $token)
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list',
    ], [
        'Authorization' => 'Bearer '.$token,
        'Accept' => 'application/json, text/event-stream',
    ]);
}

test('refresh rotates: new pair works, old PAT and old refresh are dead', function () {
    $user = $this->seedUser();
    $first = refreshDance($this, $user);

    $rotated = refreshGrant($this, $first['refresh']);
    $rotated->assertOk();
    expect($rotated->json('refresh_token'))->not->toBe($first['refresh']);
    expect($rotated->json('access_token'))->not->toBe($first['access']);

    // Exactly one live PAT: the rotation deleted the superseded one.
    expect($user->tokens()->count())->toBe(1);
    refreshMcpList($this, $first['access'])->assertStatus(401);
    expect(refreshMcpList($this, $rotated->json('access_token'))->json('result.tools'))->not->toBeEmpty();
});

test('reusing a rotated refresh token revokes the whole family', function () {
    $user = $this->seedUser();
    $first = refreshDance($this, $user);
    $second = refreshGrant($this, $first['refresh'])->json();

    // The theft replay: the OLD refresh token again.
    refreshGrant($this, $first['refresh'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');

    // Family dead: the CURRENT refresh token and PAT died with it.
    refreshGrant($this, $second['refresh_token'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
    expect($user->tokens()->count())->toBe(0);
    refreshMcpList($this, $second['access_token'])->assertStatus(401);
});

test('deleting the PAT in the UI kills the refresh token too', function () {
    $user = $this->seedUser();
    $pair = refreshDance($this, $user);

    // What ApiTokenController@destroy does: delete the PAT row. The FK sets
    // oauth_refresh_tokens.personal_access_token_id NULL — the revoke marker.
    $user->tokens()->delete();

    refreshGrant($this, $pair['refresh'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
    // And the family is flagged revoked so nothing later resurrects it.
    expect(OauthRefreshToken::whereNull('revoked_at')->count())->toBe(0);
});

test('an expired refresh token is invalid_grant', function () {
    $user = $this->seedUser();
    $pair = refreshDance($this, $user);

    $this->travel(61)->days(); // refresh lifetime is 60 days

    refreshGrant($this, $pair['refresh'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
});

test('the family cap outranks per-token expiry', function () {
    $user = $this->seedUser();
    $pair = refreshDance($this, $user);

    // Simulate a family minted 365 days ago whose latest refresh is young.
    OauthRefreshToken::query()->update(['family_expires_at' => now()->subMinute()]);

    refreshGrant($this, $pair['refresh'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
});

test('a refresh token presented with the WRONG client_id is refused', function () {
    $user = $this->seedUser();
    $pair = refreshDance($this, $user);

    $other = $this->postJson('/oauth/register', [
        'redirect_uris' => ['https://claude.ai/api/mcp/auth_callback'], 'client_name' => 'Other',
    ])->json('client_id');

    $this->post('/oauth/token', [
        'grant_type' => 'refresh_token',
        'refresh_token' => $pair['refresh'],
        'client_id' => $other,
    ], ['Accept' => 'application/json'])->assertStatus(400)->assertJsonPath('error', 'invalid_grant');
});

test('an unknown refresh token and a missing one are named errors', function () {
    refreshGrant($this, 'hrt_'.str_repeat('x', 64))
        ->assertStatus(400)->assertJsonPath('error', 'invalid_grant');

    $this->post('/oauth/token', ['grant_type' => 'refresh_token'], ['Accept' => 'application/json'])
        ->assertStatus(400)->assertJsonPath('error', 'invalid_request');
});
