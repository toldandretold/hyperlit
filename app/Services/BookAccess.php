<?php

namespace App\Services;

use App\Models\PgLibrary;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class BookAccess
{
    /**
     * Whether the current requester may read this book's content.
     * True if the book is public OR the requester owns it.
     *
     * Lives here (not inline in routes/web.php) so the route table stays
     * `route:cache`-safe: cached routes never execute the routes file, so a
     * function defined there vanishes and every caller 500s (2026-08-03 outage).
     */
    public static function canAccessBookContent(string $book, Request $request): bool
    {
        $library = PgLibrary::where('book', $book)->first();

        // If no library record, allow access (legacy or public content)
        if (! $library) {
            return true;
        }

        // Public books are accessible to everyone
        if ($library->visibility === 'public') {
            return true;
        }

        // For private books, check ownership
        $user = Auth::user();
        if ($user && $library->creator === $user->name) {
            return true;
        }

        // Check anonymous token (constant-time to prevent timing attacks)
        $anonToken = $request->cookie('anon_token');
        if ($anonToken && $library->creator_token && hash_equals((string) $library->creator_token, (string) $anonToken)) {
            return true;
        }

        return false;
    }
}
