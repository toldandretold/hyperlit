<?php

namespace App\Http\Controllers;

use App\Mcp\TokenAbilities;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * Personal access tokens for connecting external AI clients (MCP) to a
 * user's account. The plaintext token is shown exactly once, at creation;
 * Sanctum stores only its hash.
 *
 * Mint/revoke are SESSION-ONLY: a request authenticated by a token must
 * never be able to mint or revoke tokens, or one leaked token escalates
 * into permanent, self-renewing access.
 */
class ApiTokenController extends Controller
{
    /** Tokens live at most a year; the default is also a year. */
    private const MAX_LIFETIME_DAYS = 365;

    public function index(Request $request): JsonResponse
    {
        $tokens = $request->user()->tokens()
            ->orderByDesc('created_at')
            ->get()
            ->map(fn (PersonalAccessToken $token) => [
                'id' => $token->id,
                'name' => $token->name,
                'abilities' => $token->abilities,
                'last_used_at' => $token->last_used_at?->toIso8601String(),
                'created_at' => $token->created_at?->toIso8601String(),
                'expires_at' => $token->expires_at?->toIso8601String(),
            ]);

        return response()->json(['success' => true, 'tokens' => $tokens]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->assertSessionAuthenticated($request);

        $validated = $request->validate([
            'name' => ['required', 'string', 'max:100'],
            'abilities' => ['required', 'array', 'min:1'],
            'abilities.*' => ['string', Rule::in(TokenAbilities::all())],
            'expires_in_days' => ['nullable', 'integer', 'min:1', 'max:'.self::MAX_LIFETIME_DAYS],
        ]);

        $expiresAt = now()->addDays($validated['expires_in_days'] ?? self::MAX_LIFETIME_DAYS);

        $token = $request->user()->createToken(
            $validated['name'],
            array_values(array_unique($validated['abilities'])),
            $expiresAt
        );

        return response()->json([
            'success' => true,
            // Shown once — the client must copy it now.
            'token' => $token->plainTextToken,
            'token_record' => [
                'id' => $token->accessToken->id,
                'name' => $token->accessToken->name,
                'abilities' => $token->accessToken->abilities,
                'expires_at' => $token->accessToken->expires_at?->toIso8601String(),
            ],
        ], 201);
    }

    public function destroy(Request $request, int $tokenId): JsonResponse
    {
        $this->assertSessionAuthenticated($request);

        $deleted = $request->user()->tokens()->where('id', $tokenId)->delete();

        if (! $deleted) {
            return response()->json(['success' => false, 'message' => 'Token not found'], 404);
        }

        return response()->json(['success' => true]);
    }

    /**
     * Refuse token-authenticated callers. A session user coming through
     * auth:sanctum carries a TransientToken (or no token via the web guard);
     * a PAT caller carries a PersonalAccessToken model.
     */
    private function assertSessionAuthenticated(Request $request): void
    {
        if ($request->user()->currentAccessToken() instanceof PersonalAccessToken) {
            abort(403, 'API tokens cannot manage API tokens. Use the web app.');
        }
    }
}
