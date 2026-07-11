<?php

/**
 * Email verification is the app's own flow (AuthController::verifyEmail on
 * the signed verification.verify route): it verifies via the SECURITY
 * DEFINER auth_verify_user_email function and redirects to the SPA with a
 * ?verified flag. No Illuminate Verified event is fired — the SPA reads the
 * query flag instead. Users are seeded via SeedsRlsFixtures.
 */

use Illuminate\Support\Facades\URL;

test('email verification screen can be rendered', function () {
    $user = $this->seedUser(['email_verified_at' => null]);

    $response = $this->actingAs($user)->get('/verify-email');

    $response->assertStatus(200);
});

test('email can be verified via the signed link', function () {
    $user = $this->seedUser(['email_verified_at' => null]);

    $verificationUrl = URL::temporarySignedRoute(
        'verification.verify',
        now()->addMinutes(60),
        ['id' => $user->id, 'hash' => sha1($user->email)]
    );

    $response = $this->get($verificationUrl); // guest-clickable email link

    $response->assertRedirect('/?verified=1');
    // The verification UPDATE ran inside this test's transaction on the
    // DEFAULT connection — an admin-connection read would miss it, and the
    // app role can't SELECT users directly, so read through the SECURITY
    // DEFINER lookup the auth stack itself uses.
    $row = \Illuminate\Support\Facades\DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$user->id]);
    expect($row->email_verified_at)->not->toBeNull();
});

test('email is not verified with invalid hash', function () {
    $user = $this->seedUser(['email_verified_at' => null]);

    $verificationUrl = URL::temporarySignedRoute(
        'verification.verify',
        now()->addMinutes(60),
        ['id' => $user->id, 'hash' => sha1('wrong-email')]
    );

    $this->get($verificationUrl)->assertRedirect('/?verified=0');

    $row = \Illuminate\Support\Facades\DB::selectOne('SELECT * FROM auth_lookup_user_by_id(?)', [$user->id]);
    expect($row->email_verified_at)->toBeNull();
});
