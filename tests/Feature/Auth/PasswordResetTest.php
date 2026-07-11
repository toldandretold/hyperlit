<?php

/**
 * Password reset is the app's OWN flow, not Fortify's: POST
 * /api/password/forgot looks the user up via a SECURITY DEFINER function and
 * stores a SHA-256 token hash through auth_create_password_reset_token
 * (password_reset_tokens is RLS deny-all for the app role — Fortify's broker
 * routes can never work and Features::resetPasswords() is deliberately off).
 * The emailed link opens the app's GET /reset-password/{token} page, which
 * posts /api/password/reset (atomic verify+update+delete via
 * auth_execute_password_reset).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;

afterEach(function () {
    DB::connection('pgsql_admin')->table('password_reset_tokens')
        ->where('email', 'like', 'rls\_%@rlstest.local')
        ->delete();
});

test('the full email reset round trip works via the API', function () {
    // MAIL_MAILER=array: capture the real reset mail (Mail::fake cannot
    // record view-based Mail::send) and drive the emailed link end-to-end.
    $user = $this->seedUser();

    $this->postJson('/api/password/forgot', ['email' => $user->email])
        ->assertOk();

    $messages = app('mailer')->getSymfonyTransport()->messages();
    expect($messages)->toHaveCount(1);

    $body = $messages[0]->getOriginalMessage()->getHtmlBody()
        ?: $messages[0]->getOriginalMessage()->getTextBody();
    preg_match('#/reset-password/([^?\s"]+)#', $body, $m);
    expect($m)->toHaveKey(1);
    $plainToken = $m[1];

    $this->postJson('/api/password/reset', [
        'token' => $plainToken,
        'email' => $user->email,
        'password' => 'brand-new-password',
        'password_confirmation' => 'brand-new-password',
    ])->assertOk()->assertJsonPath('success', true);

    $this->postJson('/api/login', ['email' => $user->email, 'password' => 'brand-new-password'])
        ->assertOk();
});

test('an unknown email still returns success (no enumeration) and stores nothing', function () {
    Mail::fake();

    $this->postJson('/api/password/forgot', ['email' => 'rls_nobody@rlstest.local'])
        ->assertOk();

    expect(
        DB::connection('pgsql_admin')->table('password_reset_tokens')
            ->where('email', 'rls_nobody@rlstest.local')->exists()
    )->toBeFalse();
});

test('the emailed reset page renders', function () {
    $this->get('/reset-password/sometoken?email=someone%40example.org')
        ->assertOk();
});

test('password can be reset with a valid token via the API', function () {
    $user = $this->seedUser();

    // What the email would carry: a plain token whose SHA-256 is stored.
    $plain = 'test-plain-token-' . bin2hex(random_bytes(8));
    DB::selectOne('SELECT auth_create_password_reset_token(?, ?)', [$user->email, hash('sha256', $plain)]);

    $this->postJson('/api/password/reset', [
        'token' => $plain,
        'email' => $user->email,
        'password' => 'brand-new-password',
        'password_confirmation' => 'brand-new-password',
    ])->assertOk()->assertJsonPath('success', true);

    // The new password authenticates (via /api/login — the web /login is
    // Fortify with lowercase_usernames, which mixed-case seeds would miss).
    $this->postJson('/api/login', ['email' => $user->email, 'password' => 'brand-new-password'])
        ->assertOk();
});

test('an invalid token is rejected', function () {
    $user = $this->seedUser();

    $this->postJson('/api/password/reset', [
        'token' => 'not-a-real-token',
        'email' => $user->email,
        'password' => 'brand-new-password',
        'password_confirmation' => 'brand-new-password',
    ])->assertStatus(400);
});
