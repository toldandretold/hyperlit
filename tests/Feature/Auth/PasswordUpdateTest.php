<?php

/**
 * The Breeze/Fortify logged-in password-update endpoint was deliberately
 * removed (Features::updatePasswords() is off in config/fortify.php) — a
 * password change goes through the email reset flow (/api/password/forgot +
 * /api/password/reset, see PasswordResetTest). Pin the removal so a
 * re-enabled route forces a deliberate review of that decision.
 */

test('the legacy web password-update endpoint stays removed', function () {
    $user = $this->seedUser();

    $this->actingAs($user)
        ->from('/profile')
        ->put('/password', [
            'current_password' => 'password',
            'password' => 'new-password',
            'password_confirmation' => 'new-password',
        ])
        ->assertStatus(405);
});
