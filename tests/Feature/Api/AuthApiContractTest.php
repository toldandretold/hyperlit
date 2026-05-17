<?php

/**
 * Contract tests for the auth-related JSON endpoints the SPA hits at boot.
 *
 * These are not unit tests for the controllers — they assert the *shape* and
 * status code the frontend depends on. If a future refactor renames a JSON key
 * or changes the status code, the JS that consumes it will break silently
 * unless one of these fails first.
 */

test('GET /api/auth-check returns 200 with the auth-state envelope for a guest', function () {
    $response = $this->getJson('/api/auth-check');

    $response->assertStatus(200)
        ->assertJsonStructure(['authenticated', 'user', 'anonymous_token'])
        ->assertJson([
            'authenticated' => false,
            'user' => null,
            'anonymous_token' => null,
        ]);
});

test('GET /api/auth/session-info returns the session envelope shape for a guest', function () {
    // Contract: the SPA boot code expects these four keys. csrf_token may be empty
    // when no web session has started yet (the SPA boots a session before reading
    // the token), so we don't assert its value — only its presence.
    $response = $this->getJson('/api/auth/session-info');

    $response->assertStatus(200)
        ->assertJsonStructure(['authenticated', 'user', 'anonymous_token', 'csrf_token']);

    expect($response->json('authenticated'))->toBeFalse();
});

test('POST /api/anonymous-session returns a new token with the documented shape', function () {
    // Contract: SPA expects {token, type} JSON. We don't assert DB persistence here
    // because the row is created under a different RLS context than the test
    // connection sees — the next test (cookie) confirms the session was actually
    // established, which is the user-facing contract.
    $response = $this->postJson('/api/anonymous-session');

    $response->assertStatus(200)
        ->assertJsonStructure(['token', 'type'])
        ->assertJson(['type' => 'new']);

    expect($response->json('token'))->toBeString()->not->toBeEmpty();
});

test('POST /api/anonymous-session sets the anon_token cookie as HttpOnly', function () {
    $response = $this->postJson('/api/anonymous-session');

    $response->assertStatus(200);

    $cookies = collect($response->headers->getCookies())
        ->keyBy(fn ($c) => $c->getName());

    expect($cookies->has('anon_token'))->toBeTrue();
    expect($cookies['anon_token']->isHttpOnly())->toBeTrue();
});

test('GET /api/auth-check accepts no body and is not rate-limited for a single hit', function () {
    // Just hit it three times — if the public endpoint had a tight throttle this would 429.
    $this->getJson('/api/auth-check')->assertStatus(200);
    $this->getJson('/api/auth-check')->assertStatus(200);
    $this->getJson('/api/auth-check')->assertStatus(200);
});
