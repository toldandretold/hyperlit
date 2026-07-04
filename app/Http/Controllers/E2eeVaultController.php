<?php

namespace App\Http\Controllers;

use App\Models\UserE2eeVault;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * E2EE vault recovery blob (docs/e2ee.md): the vault key wrapped by the
 * recovery-code-derived KEK. The server stores it blind; only the recovery
 * code (shown once at setup, never stored) can unwrap it.
 */
class E2eeVaultController extends Controller
{
    /** GET /api/e2ee/vault — the recovery blob for a recovery-code unlock. */
    public function show(Request $request): JsonResponse
    {
        $vault = UserE2eeVault::where('user_id', $request->user()->id)->first();
        if (! $vault) {
            return response()->json(['success' => false, 'error' => 'No E2EE vault for this account'], 404);
        }

        return response()->json([
            'success' => true,
            'vault' => [
                'recovery_wrapped_vault_key' => $vault->recovery_wrapped_vault_key,
                'recovery_kdf_params' => $vault->recovery_kdf_params,
            ],
        ]);
    }

    /**
     * POST /api/e2ee/vault/recovery — rotate the recovery blob (a fresh code
     * was generated client-side and the vault key re-wrapped under it).
     */
    public function rotateRecovery(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'recovery_wrapped_vault_key' => 'required|string|max:4096',
            'recovery_kdf_params' => 'required|array',
        ]);

        $vault = UserE2eeVault::where('user_id', $request->user()->id)->first();
        if (! $vault) {
            return response()->json(['success' => false, 'error' => 'No E2EE vault for this account'], 404);
        }

        $vault->update($validated);

        return response()->json(['success' => true]);
    }
}
