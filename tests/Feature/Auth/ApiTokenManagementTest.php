<?php

use App\Mcp\TokenAbilities;
use App\Models\HyperlitPersonalAccessToken;
use App\Models\User;
use Illuminate\Support\Str;

/**
 * Personal access tokens (the MCP credential). Pins the three auth-plumbing
 * pieces that make bearer auth work against this app's RLS model:
 *
 * - User uses HasApiTokens (without it Sanctum's guard rejects EVERY token);
 * - HyperlitPersonalAccessToken resolves `tokenable` via the SECURITY DEFINER
 *   auth_lookup_user_by_id() — stock Sanctum's morphTo reads the RLS-bound
 *   users table BEFORE app.current_user is set and 401s;
 * - SetDatabaseSessionContext falls back to the sanctum guard for bearer
 *   requests, so the Postgres RLS context carries the token's user — the
 *   private-book test below is the one that fails if that fallback is lost.
 *
 * HARNESS TRAPS, deliberately worked around: (1) actingAs() leaves the web
 * guard populated for the REST of the test, and Sanctum's guard consults the
 * web guard BEFORE the bearer token — so any test asserting bearer behaviour
 * mints its token via $user->createToken() directly and never touches
 * actingAs. (2) Sanctum's RequestGuard caches the resolved user for the rest
 * of the test process (see the note in AuthenticationTest), so a test sending
 * TWO bearer identities must forgetGuards() between requests. (3) The shared
 * test DB carries committed personal_access_tokens residue from old runs, so
 * assertions scope to $user->tokens(), never the whole table. Token rows ride
 * the DEFAULT connection (pinned in HyperlitPersonalAccessToken) so
 * RefreshDatabase rolls them back.
 */

function bearerTokenFor(User $user, array $abilities = [TokenAbilities::READ]): string
{
    return $user->createToken('test token', $abilities, now()->addYear())->plainTextToken;
}

test('a session user can mint a token and the plaintext is returned once', function () {
    $user = $this->seedUser();

    $response = $this->actingAs($user)->postJson('/api/user/api-tokens', [
        'name' => 'my mcp client',
        'abilities' => [TokenAbilities::READ, TokenAbilities::ANNOTATE],
    ]);

    $response->assertStatus(201)->assertJsonPath('success', true);
    expect($response->json('token'))->toBeString()->toContain('|');
    expect($response->json('token_record.abilities'))->toEqualCanonicalizing(['read', 'annotate']);
    expect($response->json('token_record.expires_at'))->not->toBeNull();

    // The list endpoint never exposes the plaintext or the hash.
    $list = $this->getJson('/api/user/api-tokens');
    $list->assertOk()->assertJsonPath('success', true);
    expect($list->json('tokens'))->toHaveCount(1);
    expect($list->json('tokens.0'))->not->toHaveKeys(['token', 'plainTextToken']);
});

test('unknown abilities are rejected', function () {
    $user = $this->seedUser();

    $this->actingAs($user)->postJson('/api/user/api-tokens', [
        'name' => 'bad',
        'abilities' => ['read', 'sudo'],
    ])->assertStatus(422);
});

test('a token authenticates an auth:sanctum route', function () {
    $user = $this->seedUser();
    $plain = bearerTokenFor($user);

    $response = $this->getJson('/api/user/api-tokens', ['Authorization' => 'Bearer '.$plain]);

    $response->assertOk()->assertJsonPath('success', true);
    expect($response->json('tokens.0.last_used_at'))->not->toBeNull();
});

test('a token cannot mint or revoke tokens', function () {
    $user = $this->seedUser();
    $plain = bearerTokenFor($user);
    $id = $user->tokens()->value('id');

    $this->postJson('/api/user/api-tokens', [
        'name' => 'escalation',
        'abilities' => ['read'],
    ], ['Authorization' => 'Bearer '.$plain])->assertStatus(403);

    $this->deleteJson("/api/user/api-tokens/{$id}", [], ['Authorization' => 'Bearer '.$plain])
        ->assertStatus(403);

    expect($user->tokens()->count())->toBe(1);
});

test('a session user can revoke a token', function () {
    $user = $this->seedUser();
    bearerTokenFor($user);
    $id = $user->tokens()->value('id');

    $this->actingAs($user)
        ->deleteJson("/api/user/api-tokens/{$id}")
        ->assertOk()->assertJsonPath('success', true);

    expect($user->tokens()->count())->toBe(0);
});

test('a revoked token stops authenticating', function () {
    $user = $this->seedUser();
    $plain = bearerTokenFor($user);

    $user->tokens()->delete();

    $this->getJson('/api/user/api-tokens', ['Authorization' => 'Bearer '.$plain])
        ->assertStatus(401);
});

test('an expired token is rejected', function () {
    $user = $this->seedUser();
    $plain = $user->createToken('stale', [TokenAbilities::READ], now()->subDay())->plainTextToken;

    $this->getJson('/api/user/api-tokens', ['Authorization' => 'Bearer '.$plain])
        ->assertStatus(401);
});

test('a user cannot revoke another user\'s token', function () {
    $alice = $this->seedUser();
    $mallory = $this->seedUser();
    bearerTokenFor($alice);
    $id = $alice->tokens()->value('id');

    $this->actingAs($mallory)
        ->deleteJson("/api/user/api-tokens/{$id}")
        ->assertStatus(404);

    expect($alice->tokens()->whereKey($id)->exists())->toBeTrue();
});

test('bearer auth sets the RLS context: a private book is visible to its owner\'s token', function () {
    $owner = $this->seedUser();
    $book = $this->seedLibrary([
        'book' => 'book_pat_rls_'.Str::random(6),
        'visibility' => 'private',
        'creator' => $owner->name,
    ]);
    $this->seedNode([
        'book' => $book,
        'startLine' => 100,
        'node_id' => $book.'_1_test',
        'content' => '<p id="100" data-node-id="'.$book.'_1_test">hello</p>',
        'plainText' => 'hello',
    ]);
    $plain = bearerTokenFor($owner);

    // No session, no cookies — only the bearer header. is_owner is computed
    // in SQL from app.current_user, so this passes ONLY if
    // SetDatabaseSessionContext resolved the sanctum guard.
    $this->getJson("/api/database-to-indexeddb/books/{$book}/data", [
        'Authorization' => 'Bearer '.$plain,
    ])->assertOk();

    // Control: anonymous (no bearer) is refused — proves the assertion above
    // tested authorization, not public visibility. forgetGuards first:
    // Sanctum's RequestGuard caches the resolved user for the whole test
    // process (harness trap 2 in the file docblock).
    app('auth')->forgetGuards();
    $this->getJson("/api/database-to-indexeddb/books/{$book}/data")
        ->assertStatus(403);

    // Control 2: another user's token is refused.
    $other = $this->seedUser();
    $otherPlain = bearerTokenFor($other);
    app('auth')->forgetGuards();
    $this->getJson("/api/database-to-indexeddb/books/{$book}/data", [
        'Authorization' => 'Bearer '.$otherPlain,
    ])->assertStatus(403);
});
