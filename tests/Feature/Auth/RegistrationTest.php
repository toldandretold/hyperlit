<?php

/**
 * Registration has two live paths: the SPA posts /api/register
 * (AuthController::register), and the register form's action="/register" is
 * the no-JS Fortify fallback (App\Actions\Fortify\CreateNewUser). Both create
 * the user through pgsql_admin (a default-connection INSERT…RETURNING on
 * users is RLS-rejected) and share the same username rules — this file pins
 * the fallback so the two paths can't silently diverge.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

test('registration screen can be rendered', function () {
    $response = $this->get('/register');

    $response->assertStatus(200);
});

test('new users can register via the web fallback form', function () {
    $name = 'rls_regfb_' . Str::random(6);
    $email = strtolower($name) . '@rlstest.local';

    try {
        $response = $this->post('/register', [
            'name' => $name,
            'email' => $email,
            'password' => 'password',
            'password_confirmation' => 'password',
        ]);

        $this->assertAuthenticated();
        $response->assertRedirect('/');

        $row = DB::connection('pgsql_admin')->table('users')->where('email', $email)->first();
        expect($row)->not->toBeNull();
        expect($row->user_token)->not->toBeNull(); // same provisioning as /api/register
    } finally {
        // The fallback creates the user via pgsql_admin (committed, not rolled
        // back by RefreshDatabase) — remove it explicitly.
        DB::connection('pgsql_admin')->table('users')->where('email', $email)->delete();
    }
});

test('the web fallback enforces the same username rules as /api/register', function () {
    $response = $this->from('/register')->post('/register', [
        'name' => 'Test User', // space — rejected by the shared alpha_dash rule
        'email' => 'rls_regfb_invalid@rlstest.local',
        'password' => 'password',
        'password_confirmation' => 'password',
    ]);

    $response->assertSessionHasErrors('name');
    $this->assertGuest();
    expect(DB::connection('pgsql_admin')->table('users')->where('email', 'rls_regfb_invalid@rlstest.local')->exists())
        ->toBeFalse();
});
