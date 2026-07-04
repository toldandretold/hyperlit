<?php

use App\Models\PasskeyCredential;
use App\Models\UserE2eeVault;

/**
 * Passkey registration + unlock-assertion ceremonies (docs/e2ee.md).
 * Credentials are FORGED but REAL (none-attestation CBOR, ES256 signatures)
 * so webauthn-lib's validators run for real — challenge/origin/signature/
 * counter failures here are genuine rejections, not mocks.
 */

function registerForgedPasskey($test, $user): array
{
    $options = $test->postJson('/api/passkeys/registration-options')
        ->assertOk()
        ->json('options');

    $forged = $test->makeAttestationCredential($options);

    $response = $test->postJson('/api/passkeys/register', [
        'credential' => $forged['credential'],
        'name' => 'Test key',
    ])->assertOk()->json('passkey');

    return [$forged['credentialId'], $response];
}

it('rejects every endpoint for guests', function () {
    $this->getJson('/api/passkeys')->assertStatus(401);
    $this->postJson('/api/passkeys/registration-options')->assertStatus(401);
    $this->postJson('/api/passkeys/assert', ['credential' => []])->assertStatus(401);
    $this->getJson('/api/e2ee/vault')->assertStatus(401);
});

it('registers a passkey through a real attestation ceremony', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    [$credentialId, $passkey] = registerForgedPasskey($this, $user);

    expect($passkey['credential_id'])->toBe($credentialId)
        ->and($passkey['prf_salt'])->not->toBeEmpty();

    $stored = PasskeyCredential::where('user_id', $user->id)->first();
    expect($stored)->not->toBeNull()
        ->and($stored->credential_id)->toBe($credentialId)
        ->and($stored->wrapped_vault_key)->toBeNull(); // two-phase: not vault-capable yet
});

it('rejects a registration whose challenge was already consumed (replay)', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    $options = $this->postJson('/api/passkeys/registration-options')->assertOk()->json('options');
    $forged = $this->makeAttestationCredential($options);

    $this->postJson('/api/passkeys/register', ['credential' => $forged['credential']])->assertOk();

    // Same options, second time: the session challenge is gone.
    $second = $this->makeAttestationCredential($options);
    $this->postJson('/api/passkeys/register', ['credential' => $second['credential']])
        ->assertStatus(422);
});

it('rejects an attestation from a foreign origin', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    $options = $this->postJson('/api/passkeys/registration-options')->assertOk()->json('options');
    $forged = $this->makeAttestationCredential($options, origin: 'https://evil.example');

    $this->postJson('/api/passkeys/register', ['credential' => $forged['credential']])
        ->assertStatus(422);
});

it('verifies a real signed assertion and returns the wrapped blob for that credential', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    [$credentialId] = registerForgedPasskey($this, $user);

    PasskeyCredential::where('credential_id', $credentialId)->update([
        'wrapped_vault_key' => 'hlenc.v1.AAAA.BBBB',
        'kek_params' => json_encode(['version' => 'v1']),
    ]);

    $optionsResponse = $this->postJson('/api/passkeys/assertion-options')->assertOk();
    $prfSalts = $optionsResponse->json('prf_salts');
    expect($prfSalts)->toHaveKey($credentialId);

    $assertion = $this->makeAssertionCredential($optionsResponse->json('options'), $credentialId, $user->id);

    $result = $this->postJson('/api/passkeys/assert', ['credential' => $assertion])
        ->assertOk()
        ->json('passkey');

    expect($result['wrapped_vault_key'])->toBe('hlenc.v1.AAAA.BBBB')
        ->and($result['prf_salt'])->not->toBeEmpty();

    // sign_count persisted from the assertion
    expect(PasskeyCredential::where('credential_id', $credentialId)->value('sign_count'))->toBe(1);
});

it('rejects a replayed assertion (challenge consumed) and a tampered signature', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    [$credentialId] = registerForgedPasskey($this, $user);

    $options = $this->postJson('/api/passkeys/assertion-options')->assertOk()->json('options');
    $assertion = $this->makeAssertionCredential($options, $credentialId, $user->id);

    $this->postJson('/api/passkeys/assert', ['credential' => $assertion])->assertOk();
    // Replay: same assertion again — challenge is gone from the session.
    $this->postJson('/api/passkeys/assert', ['credential' => $assertion])->assertStatus(422);

    // Tampered signature on a fresh challenge
    $options2 = $this->postJson('/api/passkeys/assertion-options')->assertOk()->json('options');
    $bad = $this->makeAssertionCredential($options2, $credentialId, $user->id, signCount: 2);
    $sig = $bad['response']['signature'];
    $bad['response']['signature'] = substr($sig, 0, -4) . ($sig[strlen($sig) - 4] === 'A' ? 'BBBB' : 'AAAA');
    $this->postJson('/api/passkeys/assert', ['credential' => $bad])->assertStatus(422);
});

it("refuses another user's credential in an assertion", function () {
    $owner = $this->seedUser();
    $this->actingAs($owner);
    [$credentialId] = registerForgedPasskey($this, $owner);

    $attacker = $this->seedUser();
    $this->actingAs($attacker);
    // Attacker has no passkeys — options endpoint 404s...
    $this->postJson('/api/passkeys/assertion-options')->assertStatus(404);

    // ...and even with a forged options payload the credential lookup is user-scoped.
    [$attackerCredId] = registerForgedPasskey($this, $attacker);
    $options = $this->postJson('/api/passkeys/assertion-options')->assertOk()->json('options');
    $assertion = $this->makeAssertionCredential($options, $credentialId, $owner->id);
    $this->postJson('/api/passkeys/assert', ['credential' => $assertion])->assertStatus(422);
});

it('stores the wrapped vault key + recovery blob transactionally on first setup', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    [, $passkey] = registerForgedPasskey($this, $user);

    // First setup WITHOUT the recovery blob → rejected
    $this->postJson("/api/passkeys/{$passkey['id']}/vault-key", [
        'wrapped_vault_key' => 'hlenc.v1.AAAA.BBBB',
    ])->assertStatus(422);

    $this->postJson("/api/passkeys/{$passkey['id']}/vault-key", [
        'wrapped_vault_key' => 'hlenc.v1.AAAA.BBBB',
        'kek_params' => ['version' => 'v1'],
        'recovery' => [
            'recovery_wrapped_vault_key' => 'hlenc.v1.CCCC.DDDD',
            'recovery_kdf_params' => ['alg' => 'PBKDF2-SHA256', 'salt' => 'abc', 'iterations' => 310000],
        ],
    ])->assertOk();

    expect(PasskeyCredential::find($passkey['id'])->wrapped_vault_key)->toBe('hlenc.v1.AAAA.BBBB');
    $vault = UserE2eeVault::where('user_id', $user->id)->first();
    expect($vault)->not->toBeNull()
        ->and($vault->recovery_wrapped_vault_key)->toBe('hlenc.v1.CCCC.DDDD');
});

it('serves and rotates the recovery blob only to its owner', function () {
    $user = $this->seedUser();
    UserE2eeVault::create([
        'user_id' => $user->id,
        'recovery_wrapped_vault_key' => 'hlenc.v1.EEEE.FFFF',
        'recovery_kdf_params' => ['iterations' => 310000, 'salt' => 'xyz'],
    ]);

    $this->actingAs($user);
    $this->getJson('/api/e2ee/vault')
        ->assertOk()
        ->assertJsonPath('vault.recovery_wrapped_vault_key', 'hlenc.v1.EEEE.FFFF');

    $this->postJson('/api/e2ee/vault/recovery', [
        'recovery_wrapped_vault_key' => 'hlenc.v1.GGGG.HHHH',
        'recovery_kdf_params' => ['iterations' => 310000, 'salt' => 'new'],
    ])->assertOk();
    expect(UserE2eeVault::where('user_id', $user->id)->value('recovery_wrapped_vault_key'))
        ->toBe('hlenc.v1.GGGG.HHHH');

    $other = $this->seedUser();
    $this->actingAs($other);
    $this->getJson('/api/e2ee/vault')->assertStatus(404);
});

it('refuses to delete the last vault-capable passkey', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    [, $first] = registerForgedPasskey($this, $user);

    PasskeyCredential::whereKey($first['id'])->update(['wrapped_vault_key' => 'hlenc.v1.AAAA.BBBB']);

    $this->deleteJson("/api/passkeys/{$first['id']}")->assertStatus(409);

    // A second vault-capable passkey unblocks deletion
    [, $second] = registerForgedPasskey($this, $user);
    PasskeyCredential::whereKey($second['id'])->update(['wrapped_vault_key' => 'hlenc.v1.IIII.JJJJ']);

    $this->deleteJson("/api/passkeys/{$first['id']}")->assertOk();
    expect(PasskeyCredential::find($first['id']))->toBeNull();
});
