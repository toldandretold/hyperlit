<?php

namespace App\Policies;

use App\Models\PgHyperlight;
use App\Models\User;
use Illuminate\Http\Request;

class HyperlightPolicy
{
    /**
     * Check if user can view the hyperlight.
     * Hyperlights are viewable if the user can view the parent book.
     */
    public function view(?User $user, PgHyperlight $hyperlight, Request $request): bool
    {
        // For now, visibility follows book visibility
        // This would be enhanced to check book visibility
        return true;
    }

    /**
     * Check if user can update the hyperlight.
     * Only the creator can modify their hyperlights.
     */
    public function update(?User $user, PgHyperlight $hyperlight, Request $request): bool
    {
        return $this->isCreator($user, $hyperlight, $request);
    }

    /**
     * Check if user can delete the hyperlight.
     * Only the creator can delete their hyperlights.
     */
    public function delete(?User $user, PgHyperlight $hyperlight, Request $request): bool
    {
        return $this->isCreator($user, $hyperlight, $request);
    }

    /**
     * Determine if the user is the creator of the hyperlight.
     */
    protected function isCreator(?User $user, PgHyperlight $hyperlight, Request $request): bool
    {
        // Logged-in user check
        if ($user && $hyperlight->creator === $user->name) {
            return true;
        }

        // Anonymous user check via token
        $anonToken = $request->cookie('anon_token');
        if ($anonToken && $hyperlight->creator_token) {
            return hash_equals($hyperlight->creator_token, $anonToken);
        }

        return false;
    }
}
