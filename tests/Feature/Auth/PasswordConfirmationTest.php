<?php

/**
 * Password confirmation is Fortify's /user/confirm-password (the Breeze
 * scaffold's /confirm-password POST route does not exist here — GETs to
 * arbitrary paths render the SPA shell via the catch-all). Users are seeded
 * via SeedsRlsFixtures; RlsUserProvider handles the credential lookup.
 */

test('confirm password screen can be rendered', function () {
    $user = $this->seedUser();

    $response = $this->actingAs($user)->get('/confirm-password');

    $response->assertStatus(200);
});

test('password can be confirmed', function () {
    $user = $this->seedUser();

    $response = $this->actingAs($user)->post('/user/confirm-password', [
        'password' => 'password',
    ]);

    $response->assertRedirect();
    $response->assertSessionHasNoErrors();
});

test('password is not confirmed with invalid password', function () {
    $user = $this->seedUser();

    $response = $this->actingAs($user)->post('/user/confirm-password', [
        'password' => 'wrong-password',
    ]);

    $response->assertSessionHasErrors();
});
