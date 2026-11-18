<?php

/**
 * GATE: a login must still be a login on the NEXT request.
 *
 * The rest of the suite authenticates with actingAs(), which never exercises
 * the real post-login path: StartSession → Sanctum's AuthenticateSession
 * comparing the session's `password_hash_web` against the user's current hash.
 * Laravel 12.45+ stores an HMAC of the hash there; laravel/sanctum < 4.2.2 still
 * compared the raw bcrypt string, so after the 2026-11-18 framework upgrade
 * every login returned 200 and the first stateful request after it was a 401
 * (device logged out, session flushed, AuthenticationException). The PHP suite
 * was green; the grand-tour e2e caught it. This pins the whole round trip
 * through the SPA's stateful middleware stack, with no actingAs anywhere.
 */

use Illuminate\Support\Facades\DB;

function spaHeaders(): array
{
    // What a browser on the app's own origin sends: this is what makes Sanctum
    // treat the request as stateful (session + CSRF + AuthenticateSession).
    $origin = rtrim(config('app.url'), '/');

    return ['Origin' => $origin, 'Referer' => $origin.'/', 'Accept' => 'application/json'];
}

test('the request after /api/login is still authenticated, and so is a CSRF-protected write', function () {
    $user = $this->seedUser();

    $login = $this->withHeaders(spaHeaders())
        ->postJson('/api/login', ['email' => $user->email, 'password' => 'password']);
    $login->assertOk()->assertJsonPath('success', true)->assertJsonPath('user.id', $user->id);

    // The session now carries the login AND the password-hash fingerprint that
    // AuthenticateSession checks on every later request.
    expect(session()->has('password_hash_web'))->toBeTrue();

    // Request 2: must come back as the same user, not as a fresh anonymous
    // session (the controller answers 200 + authenticated:false for anonymous,
    // so a bare status assertion would not catch the regression).
    $this->withHeaders(spaHeaders())->getJson('/api/auth-check')
        ->assertOk()
        ->assertJsonPath('authenticated', true)
        ->assertJsonPath('user.id', $user->id);

    // Request 3: a CSRF-protected write — the e2e auth setup's exact call.
    $this->withHeaders(spaHeaders() + ['X-CSRF-TOKEN' => csrf_token()])
        ->postJson('/api/user/preferences', ['reading_mode' => null])
        ->assertOk();

    // And the session was not flushed behind our back.
    expect(session()->has('password_hash_web'))->toBeTrue();
    expect(auth()->check())->toBeTrue();
});

test('the fingerprint AuthenticateSession stores is what the guard will accept on the next request', function () {
    // Pins the contract that broke: whatever format the framework writes into
    // password_hash_web, Sanctum's middleware must validate it. If either side
    // moves again (raw bcrypt vs HMAC), this fails with a readable message
    // instead of a mystery 401 in the browser.
    $user = $this->seedUser();
    $this->withHeaders(spaHeaders())
        ->postJson('/api/login', ['email' => $user->email, 'password' => 'password'])
        ->assertOk();

    $stored = session('password_hash_web');
    $guard = auth()->guard('web');
    $expected = method_exists($guard, 'hashPasswordForCookie')
        ? $guard->hashPasswordForCookie($user->getAuthPassword())
        : $user->getAuthPassword();

    expect($stored)->toBeString();
    expect(hash_equals($expected, $stored))->toBeTrue(
        'session password_hash_web is in a format the web guard would not accept — Sanctum and the framework disagree on how the hash is stored'
    );
});
