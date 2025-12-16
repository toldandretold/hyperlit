<?php

namespace App\Policies;

use App\Models\PgLibrary;
use App\Models\User;
use Illuminate\Http\Request;

class LibraryPolicy
{
    /**
     * Check if user can view the book.
     * Public books are accessible to everyone.
     * Private books require ownership.
     */
    public function view(?User $user, PgLibrary $library, Request $request): bool
    {
        // Public books are accessible to everyone
        if ($library->visibility === 'public') {
            return true;
        }

        return $this->isOwner($user, $library, $request);
    }

    /**
     * Check if user can update the book.
     * Only owners can modify book metadata.
     */
    public function update(?User $user, PgLibrary $library, Request $request): bool
    {
        return $this->isOwner($user, $library, $request);
    }

    /**
     * Check if user can delete the book.
     * Only logged-in owners can delete.
     */
    public function delete(?User $user, PgLibrary $library): bool
    {
        // Only logged-in users can delete
        if (!$user) {
            return false;
        }

        return $library->creator === $user->name;
    }

    /**
     * Check if user can create content in the book (highlights, nodes, etc).
     * Owners and (for public books) any authenticated user can add content.
     */
    public function createContent(?User $user, PgLibrary $library, Request $request): bool
    {
        // Must have valid session (handled by middleware)
        return true;
    }

    /**
     * Determine if the user is the owner of the book.
     * Supports both logged-in users (by username) and anonymous users (by token).
     */
    protected function isOwner(?User $user, PgLibrary $library, Request $request): bool
    {
        // Logged-in user check
        if ($user && $library->creator === $user->name) {
            return true;
        }

        // Anonymous user check via token
        $anonToken = $request->cookie('anon_token');
        if ($anonToken && $library->creator_token && hash_equals($library->creator_token, $anonToken)) {
            // Only consider anonymous ownership if there's no registered creator
            return $library->creator === null;
        }

        return false;
    }
}
