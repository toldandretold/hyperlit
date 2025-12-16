<?php

namespace App\Services;

use App\Models\AnonymousSession;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;

/**
 * Centralized service for handling authentication and session management.
 * Supports both registered users (via Sanctum) and anonymous users (via token).
 */
class AuthSessionService
{
    /**
     * Get creator information based on the current auth state.
     * Returns array with 'creator', 'creator_token', and 'valid' keys.
     */
    public function getCreatorInfo(Request $request): array
    {
        $user = Auth::user();

        if ($user) {
            return [
                'creator' => $user->name,
                'creator_token' => null,
                'valid' => true,
                'type' => 'authenticated'
            ];
        }

        // Anonymous user - validate server token
        $anonToken = $request->cookie('anon_token');

        if (!$anonToken || !$this->isValidAnonymousToken($anonToken)) {
            return [
                'creator' => null,
                'creator_token' => null,
                'valid' => false,
                'type' => 'invalid'
            ];
        }

        // Update last used time for the anonymous session
        AnonymousSession::where('token', $anonToken)
            ->update(['last_used_at' => now()]);

        return [
            'creator' => null,
            'creator_token' => $anonToken,
            'valid' => true,
            'type' => 'anonymous'
        ];
    }

    /**
     * Check if an anonymous token is valid.
     * Tokens expire after 90 days.
     */
    public function isValidAnonymousToken(?string $token): bool
    {
        if (!$token) {
            return false;
        }

        $session = AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(90))
            ->first();

        return $session !== null;
    }

    /**
     * Check if the current user/session owns a resource.
     *
     * @param Request $request The current request
     * @param string|null $creator The resource's creator username
     * @param string|null $creatorToken The resource's creator token
     */
    public function isOwner(Request $request, ?string $creator, ?string $creatorToken): bool
    {
        $user = Auth::user();

        // Logged-in user check
        if ($user && $creator && $creator === $user->name) {
            return true;
        }

        // Anonymous user check via token
        $anonToken = $request->cookie('anon_token');
        if ($anonToken && $creatorToken) {
            // Use timing-safe comparison
            return hash_equals($creatorToken, $anonToken) && $creator === null;
        }

        return false;
    }

    /**
     * Get the current authenticated user, if any.
     */
    public function getCurrentUser(): ?\App\Models\User
    {
        return Auth::user();
    }

    /**
     * Get the anonymous token from the request, if present.
     */
    public function getAnonymousToken(Request $request): ?string
    {
        return $request->cookie('anon_token');
    }
}
