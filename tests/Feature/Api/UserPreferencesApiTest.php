<?php

/**
 * User preferences (UserPreferencesController) — auth:sanctum.
 * update() writes users.preferences via pgsql_admin; the user is created via
 * pgsql_admin too, so no cross-connection lock.
 */

afterEach(fn () => $this->cleanupApiFixtures());

test('GET /api/user/preferences requires authentication', function () {
    $this->assertApiError($this->getJson('/api/user/preferences'), 401);
});

test('POST /api/user/preferences requires authentication', function () {
    $this->assertApiError($this->postJson('/api/user/preferences', ['theme' => 'dark']), 401);
});

test('GET /api/user/preferences returns a preferences object', function () {
    $this->loginUser();
    $this->getJson('/api/user/preferences')->assertStatus(200);
});

test('POST /api/user/preferences persists an allowed key and echoes the merged object', function () {
    $this->loginUser();
    $this->postJson('/api/user/preferences', ['theme' => 'dark'])
        ->assertStatus(200)
        ->assertJson(['theme' => 'dark']);
});

test('POST /api/user/preferences ignores keys outside the allow-list', function () {
    $this->loginUser();
    // Only ALLOWED_KEYS pass through ($request->only(...)); a junk key is dropped.
    $this->postJson('/api/user/preferences', ['not_a_real_pref' => 'x'])
        ->assertStatus(200)
        ->assertJsonMissing(['not_a_real_pref' => 'x']);
});
