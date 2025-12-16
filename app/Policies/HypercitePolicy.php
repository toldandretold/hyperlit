<?php

namespace App\Policies;

use App\Models\PgHypercite;
use App\Models\User;
use Illuminate\Http\Request;

class HypercitePolicy
{
    /**
     * Check if user can view the hypercite.
     */
    public function view(?User $user, PgHypercite $hypercite, Request $request): bool
    {
        // For now, visibility follows book visibility
        return true;
    }

    /**
     * Check if user can update the hypercite.
     * Only the creator can modify their hypercites.
     */
    public function update(?User $user, PgHypercite $hypercite, Request $request): bool
    {
        return $this->isCreator($user, $hypercite, $request);
    }

    /**
     * Check if user can delete the hypercite.
     * Only the creator can delete their hypercites.
     */
    public function delete(?User $user, PgHypercite $hypercite, Request $request): bool
    {
        return $this->isCreator($user, $hypercite, $request);
    }

    /**
     * Determine if the user is the creator of the hypercite.
     */
    protected function isCreator(?User $user, PgHypercite $hypercite, Request $request): bool
    {
        // Logged-in user check
        if ($user && $hypercite->creator === $user->name) {
            return true;
        }

        // Anonymous user check via token
        $anonToken = $request->cookie('anon_token');
        if ($anonToken && $hypercite->creator_token) {
            return hash_equals($hypercite->creator_token, $anonToken);
        }

        return false;
    }
}
