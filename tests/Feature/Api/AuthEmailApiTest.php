<?php

/**
 * Authenticated account endpoints (AuthController): email resend/change.
 * Both are auth:sanctum + throttled. The happy paths send mail / mutate the user,
 * so we pin the auth guard (the rest of the auth surface is in AuthApiContractTest
 * and the Auth/ suite).
 */

afterEach(fn () => $this->cleanupApiFixtures());

test('POST /api/email/resend requires authentication', function () {
    $this->assertApiError($this->postJson('/api/email/resend'), 401);
});

test('POST /api/email/change requires authentication', function () {
    $this->assertApiError($this->postJson('/api/email/change', ['email' => 'new@example.com']), 401);
});

/* ─── auth.php routes (no /api prefix), all auth:sanctum ───────────── */

test('GET /user requires authentication', function () {
    $this->assertApiError($this->getJson('/user'), 401);
});

test('GET /user returns the authenticated user envelope', function () {
    $user = $this->loginUser();
    $this->getJson('/user')
        ->assertStatus(200)
        ->assertJson(['authenticated' => true, 'user' => ['email' => $user->email]]);
});

test('POST /logout requires authentication', function () {
    $this->assertApiError($this->postJson('/logout'), 401);
});

test('POST /books/{book}/transfer-ownership requires authentication', function () {
    $this->assertApiError($this->postJson('/books/apitest_x/transfer-ownership'), 401);
});
