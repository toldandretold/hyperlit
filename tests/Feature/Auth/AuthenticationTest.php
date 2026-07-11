<?php

/**
 * Breeze scaffold updated to this app's REAL auth surface: web POST /login is
 * Fortify (RlsUserProvider does the RLS-bypassing lookup), logout is the
 * app's JSON endpoint (AuthController::logout), and there is no dashboard
 * route — the SPA lives at '/'. Users are seeded via SeedsRlsFixtures
 * (bound in Pest.php): bare User::factory()->create() is RLS-rejected.
 */

test('login screen can be rendered', function () {
    $response = $this->get('/login');

    $response->assertStatus(200);
});

test('users can authenticate using the login screen', function () {
    // Fortify lowercases the submitted email (fortify.lowercase_usernames),
    // and the SECURITY DEFINER lookup is an exact match — seed lowercase.
    $user = $this->seedUser(['email' => 'rls_login_' . strtolower(\Illuminate\Support\Str::random(8)) . '@rlstest.local']);

    $response = $this->post('/login', [
        'email' => $user->email,
        'password' => 'password',
    ]);

    $this->assertAuthenticated('web');
    $response->assertRedirect('/');
});

test('users can not authenticate with invalid password', function () {
    $user = $this->seedUser();

    $this->post('/login', [
        'email' => $user->email,
        'password' => 'wrong-password',
    ]);

    $this->assertGuest();
});

test('users can logout', function () {
    $user = $this->seedUser();

    $response = $this->actingAs($user)->post('/logout');

    $response->assertOk()->assertJsonPath('success', true);
    // Assert the web guard explicitly: the request flipped the app's default
    // guard to sanctum (auth middleware shouldUse), whose RequestGuard caches
    // the pre-logout user for the rest of the test process.
    $this->assertGuest('web');
});
