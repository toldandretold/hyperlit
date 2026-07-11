<?php

/**
 * The Breeze profile-mutation surface (PATCH/DELETE /profile) was
 * deliberately removed — profile and account management live in the SPA's
 * settings flows and the API. GET /profile still renders. Pin both facts so
 * a re-added mutation route forces a deliberate review. Users are seeded via
 * SeedsRlsFixtures (bound inline here — this file sits outside the
 * directories Pest.php binds it to).
 */

use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class);

afterEach(function () {
    $this->cleanupRlsFixtures();
});

test('profile page is displayed', function () {
    $user = $this->seedUser();

    $response = $this
        ->actingAs($user)
        ->get('/profile');

    $response->assertOk();
});

test('the legacy profile mutation endpoints stay removed', function () {
    $user = $this->seedUser();

    $this->actingAs($user)
        ->patch('/profile', ['name' => 'newname', 'email' => $user->email])
        ->assertStatus(405);

    $this->actingAs($user)
        ->delete('/profile', ['password' => 'password'])
        ->assertStatus(405);
});
