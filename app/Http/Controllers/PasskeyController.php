<?php

namespace App\Http\Controllers;

use App\Models\PasskeyCredential;
use App\Models\UserE2eeVault;
use App\Services\E2ee\WebAuthnService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Throwable;
use Webauthn\Exception\WebauthnException;

/**
 * Passkey registration + assertion for the E2EE unlock ceremony (docs/e2ee.md).
 *
 * The server verifies WebAuthn ceremonies and stores per-credential wrapped
 * vault-key blobs; the PRF output (and thus every key) exists only client-side.
 * Registration is two-phase: /register stores the credential, then the client
 * runs one assertion to obtain its PRF output and POSTs the wrapped vault key
 * to /passkeys/{id}/vault-key.
 */
class PasskeyController extends Controller
{
    public function __construct(private readonly WebAuthnService $webauthn)
    {
    }

    /** GET /api/passkeys — the user's registered passkeys (no secrets). */
    public function index(Request $request): JsonResponse
    {
        $passkeys = PasskeyCredential::where('user_id', $request->user()->id)
            ->orderBy('created_at')
            ->get()
            ->map(fn (PasskeyCredential $c) => [
                'id' => $c->id,
                'name' => $c->name,
                'aaguid' => $c->aaguid,
                'created_at' => $c->created_at?->toIso8601String(),
                'has_vault_key' => $c->wrapped_vault_key !== null,
            ]);

        return response()->json([
            'success' => true,
            'passkeys' => $passkeys,
            'has_vault' => UserE2eeVault::where('user_id', $request->user()->id)->exists(),
        ]);
    }

    /** POST /api/passkeys/registration-options */
    public function registrationOptions(Request $request): JsonResponse
    {
        $optionsJson = $this->webauthn->creationOptions($request->user());

        return response()->json([
            'success' => true,
            'options' => json_decode($optionsJson, true),
        ]);
    }

    /** POST /api/passkeys/register {credential, name?} */
    public function register(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'credential' => 'required|array',
            'name' => 'nullable|string|max:100',
        ]);

        try {
            $record = $this->webauthn->verifyAttestation(json_encode($validated['credential']), $request);
        } catch (WebauthnException $e) {
            return response()->json(['success' => false, 'error' => $e->getMessage()], 422);
        }

        $credential = PasskeyCredential::create([
            'user_id' => $request->user()->id,
            'credential_id' => WebAuthnService::b64urlEncode($record->publicKeyCredentialId),
            'public_key' => WebAuthnService::b64urlEncode($record->credentialPublicKey),
            'transports' => $record->transports,
            'sign_count' => $record->counter,
            'aaguid' => (string) $record->aaguid,
            'name' => $validated['name'] ?? null,
            // Used BOTH as the PRF eval input and the HKDF salt (public values;
            // the secrecy lives in the authenticator's PRF).
            'prf_salt' => WebAuthnService::b64urlEncode(random_bytes(32)),
        ]);

        return response()->json([
            'success' => true,
            'passkey' => [
                'id' => $credential->id,
                'credential_id' => $credential->credential_id,
                'prf_salt' => $credential->prf_salt,
            ],
        ]);
    }

    /** POST /api/passkeys/assertion-options — challenge + per-credential PRF salts. */
    public function assertionOptions(Request $request): JsonResponse
    {
        $user = $request->user();
        $credentials = PasskeyCredential::where('user_id', $user->id)->get();
        if ($credentials->isEmpty()) {
            return response()->json(['success' => false, 'error' => 'No passkeys registered'], 404);
        }

        $optionsJson = $this->webauthn->requestOptions($user);

        return response()->json([
            'success' => true,
            'options' => json_decode($optionsJson, true),
            // credential_id (b64url) → prf_salt, for extensions.prf.evalByCredential
            'prf_salts' => $credentials->pluck('prf_salt', 'credential_id'),
        ]);
    }

    /**
     * POST /api/passkeys/assert {credential} — verify the unlock assertion and
     * return the wrapped vault key THIS credential can unwrap. The PRF output
     * stays client-side; this response is useless without it.
     */
    public function assert(Request $request): JsonResponse
    {
        $validated = $request->validate(['credential' => 'required|array']);

        try {
            $stored = $this->webauthn->verifyAssertion(json_encode($validated['credential']), $request->user(), $request);
        } catch (WebauthnException $e) {
            return response()->json(['success' => false, 'error' => $e->getMessage()], 422);
        } catch (Throwable $e) {
            return response()->json(['success' => false, 'error' => 'Assertion verification failed'], 422);
        }

        $stored->save(); // persist updated sign_count

        return response()->json([
            'success' => true,
            'passkey' => [
                'id' => $stored->id,
                'credential_id' => $stored->credential_id,
                'prf_salt' => $stored->prf_salt,
                'kek_params' => $stored->kek_params,
                'wrapped_vault_key' => $stored->wrapped_vault_key,
            ],
        ]);
    }

    /**
     * POST /api/passkeys/{id}/vault-key — attach the wrapped vault key produced
     * client-side after this credential's first PRF assertion. On FIRST vault
     * setup the recovery blob rides along (transactional).
     */
    public function storeVaultKey(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'wrapped_vault_key' => 'required|string|max:4096',
            'kek_params' => 'nullable|array',
            'recovery.recovery_wrapped_vault_key' => 'nullable|string|max:4096',
            'recovery.recovery_kdf_params' => 'nullable|array',
        ]);

        $credential = PasskeyCredential::where('user_id', $request->user()->id)->findOrFail($id);

        $hasVault = UserE2eeVault::where('user_id', $request->user()->id)->exists();
        $recovery = $validated['recovery'] ?? $request->input('recovery');
        if (! $hasVault && empty($recovery['recovery_wrapped_vault_key'])) {
            return response()->json([
                'success' => false,
                'error' => 'First vault setup must include the recovery blob',
            ], 422);
        }

        DB::transaction(function () use ($credential, $validated, $recovery, $hasVault, $request) {
            $credential->update([
                'wrapped_vault_key' => $validated['wrapped_vault_key'],
                'kek_params' => $validated['kek_params'] ?? null,
            ]);

            if (! $hasVault) {
                UserE2eeVault::create([
                    'user_id' => $request->user()->id,
                    'recovery_wrapped_vault_key' => $recovery['recovery_wrapped_vault_key'],
                    'recovery_kdf_params' => $recovery['recovery_kdf_params'] ?? [],
                ]);
            }
        });

        return response()->json(['success' => true]);
    }

    /** PATCH /api/passkeys/{id} {name} */
    public function update(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate(['name' => 'required|string|max:100']);
        $credential = PasskeyCredential::where('user_id', $request->user()->id)->findOrFail($id);
        $credential->update(['name' => $validated['name']]);

        return response()->json(['success' => true]);
    }

    /** DELETE /api/passkeys/{id} — refuses to remove the LAST vault-capable passkey. */
    public function destroy(Request $request, int $id): JsonResponse
    {
        $credential = PasskeyCredential::where('user_id', $request->user()->id)->findOrFail($id);

        if ($credential->wrapped_vault_key !== null) {
            $otherVaultCapable = PasskeyCredential::where('user_id', $request->user()->id)
                ->where('id', '!=', $credential->id)
                ->whereNotNull('wrapped_vault_key')
                ->exists();
            if (! $otherVaultCapable) {
                return response()->json([
                    'success' => false,
                    'error' => 'This is the last passkey that can unlock your encrypted books. Add another passkey first (the recovery code would be your only way in).',
                    'requires_confirmation' => true,
                ], 409);
            }
        }

        $credential->delete();

        return response()->json(['success' => true]);
    }
}
