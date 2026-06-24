<?php

namespace App\Services;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * The user_reading_positions "bookmark" — a per-(book, identity) saved scroll position
 * stored DIRECTLY as a chunk_id (double precision) plus an optional element_id anchor.
 *
 * Single source of truth for resolving the current request's saved position, shared by:
 *   - DatabaseToIndexedDBController (the API `resume`/getInitialChunk read), and
 *   - TextController (the server-side first-chunk prerender),
 * so the prerendered chunk and the client's `resume=true` fetch always resolve to the
 * SAME chunk. Identity = the authenticated user's name, else the anon_token cookie.
 */
class ReadingPosition
{
    /**
     * @return array{chunk_id: float, element_id: ?string}|null
     */
    public static function lookup(Request $request, string $book): ?array
    {
        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        $query = DB::table('user_reading_positions')->where('book', $book);

        if ($user) {
            $query->where('user_name', $user->name);
        } elseif ($anonymousToken) {
            $query->where('anon_token', $anonymousToken);
        } else {
            return null;
        }

        $position = $query->first();
        if (! $position) {
            return null;
        }

        return [
            'chunk_id' => (float) $position->chunk_id,
            'element_id' => $position->element_id,
        ];
    }
}
